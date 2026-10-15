using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPCommandSet.Services
{
    public class QueryModelEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public JObject Parameters { get; private set; }
        public object Result { get; private set; }

        public void SetParameters(JObject parameters)
        {
            Parameters = parameters ?? new JObject();
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) => _resetEvent.WaitOne(timeoutMilliseconds);

        public void Execute(UIApplication app)
        {
            try
            {
                var uiDoc = app.ActiveUIDocument;
                var doc = uiDoc.Document;
                var input = Parameters ?? new JObject();

                var searchScope = input.Value<string>("searchScope") ?? "CurrentView";
                var viewId = input.Value<long?>("viewId");
                var selectedOnly = input.Value<bool?>("selectedOnly") ?? false;
                var inclusion = input.Value<string>("elementInclusionMode") ?? "InstancesOnly";
                var categories = input["categories"]?.ToObject<List<string>>();
                var familyNames = ReadStringList(input, "familyNameFilters", "familyNames");
                var elementNames = ReadStringList(input, "elementNameFilters", "elementNames");
                var levelNames = ReadStringList(input, "levelNameFilters", "levelNames");
                var boundingBox = input["boundingBox"] as JObject;
                var bboxMode = input.Value<string>("boundingBoxFilteringMode") ?? "ElementsIntersecting";
                var parameterFilters = input["parameterFilters"] as JArray;
                var maxResults = input.Value<int?>("maxResults") ?? 0;
                var includeLinkedModels = input.Value<bool?>("includeLinkedModels") ?? false;

                View scopeView = null;
                if (!selectedOnly)
                {
                    if (string.Equals(searchScope, "SpecificView", StringComparison.OrdinalIgnoreCase))
                    {
                        if (!viewId.HasValue)
                            throw new ArgumentException("viewId is required when searchScope is SpecificView");
                        scopeView = doc.GetElement(PublicMcpUtils.Id(viewId.Value)) as View
                                    ?? throw new Exception($"View {viewId.Value} was not found");
                    }
                    else if (!string.Equals(searchScope, "AllViews", StringComparison.OrdinalIgnoreCase))
                    {
                        scopeView = doc.ActiveView
                                    ?? throw new Exception("Current view not found. Consider getting elements from all views.");
                    }
                }

                var hostMatches = CollectMatches(
                    doc,
                    uiDoc,
                    scopeView,
                    searchScope,
                    selectedOnly,
                    inclusion,
                    categories,
                    familyNames,
                    elementNames,
                    levelNames,
                    boundingBox,
                    bboxMode,
                    parameterFilters);

                var refs = new List<object>();
                foreach (var element in hostMatches)
                {
                    refs.Add(new
                    {
                        elementId = element.Id.GetValue(),
                        linkInstanceId = (long?)null,
                        linkName = (string)null
                    });
                }

                var linkedMatchCount = 0;
                var unloadedLinks = 0;
                var loadedLinks = 0;
                if (includeLinkedModels && !selectedOnly)
                {
                    var links = new FilteredElementCollector(doc)
                        .OfClass(typeof(RevitLinkInstance))
                        .Cast<RevitLinkInstance>()
                        .ToList();

                    foreach (var link in links)
                    {
                        var linkDoc = link.GetLinkDocument();
                        if (linkDoc == null)
                        {
                            unloadedLinks++;
                            continue;
                        }

                        loadedLinks++;
                        List<Element> linkedElements;
                        if (!string.Equals(searchScope, "AllViews", StringComparison.OrdinalIgnoreCase)
                            && scopeView != null)
                        {
                            // Elements from this link that appear in the host view.
                            linkedElements = CollectMatchesFromLinkInView(
                                doc,
                                link,
                                scopeView,
                                inclusion,
                                categories,
                                familyNames,
                                elementNames,
                                levelNames,
                                boundingBox,
                                bboxMode,
                                parameterFilters);
                        }
                        else
                        {
                            linkedElements = CollectMatches(
                                linkDoc,
                                null,
                                null,
                                "AllViews",
                                false,
                                inclusion,
                                categories,
                                familyNames,
                                elementNames,
                                levelNames,
                                boundingBox,
                                bboxMode,
                                parameterFilters);
                        }

                        foreach (var element in linkedElements)
                        {
                            refs.Add(new
                            {
                                elementId = element.Id.GetValue(),
                                linkInstanceId = (long?)link.Id.GetValue(),
                                linkName = link.Name
                            });
                            linkedMatchCount++;
                        }
                    }
                }

                var analysis = BuildAnalysis(doc, hostMatches);
                var limit = maxResults > 0 ? Math.Min(maxResults, refs.Count) : refs.Count;
                var limitedRefs = refs.Take(limit).ToList();

                // Host-only ids for backward compatibility (callers that only read elementIds).
                var hostOnlyIds = limitedRefs
                    .Select(r => JObject.FromObject(r))
                    .Where(j => j["linkInstanceId"] == null || j["linkInstanceId"].Type == JTokenType.Null)
                    .Select(j => j.Value<long>("elementId"))
                    .ToList();

                string message = null;
                if (refs.Count == 0)
                {
                    if (familyNames != null)
                        message = "No elements have family names matching provided FamilyNameFilters.";
                    else if (levelNames != null)
                        message = "No levels match provided LevelNameFilters. Run query_model to find level ids and get_element_data to find their names.";
                    else if (elementNames != null)
                        message = "No elements match provided ElementNameFilters. ";
                    else if (parameterFilters != null && parameterFilters.Count > 0)
                        message = "No elements match provided ParameterFilterCriteria.";
                }
                else if (includeLinkedModels)
                {
                    message =
                        $"Host {hostMatches.Count}, linked {linkedMatchCount} from {loadedLinks} loaded link(s)"
                        + (unloadedLinks > 0 ? $", {unloadedLinks} unloaded skipped" : "")
                        + ".";
                }

                Result = new
                {
                    results = new
                    {
                        elementIds = hostOnlyIds,
                        elementRefs = limitedRefs,
                        analysis
                    },
                    matchedCount = refs.Count,
                    returnedCount = limitedRefs.Count,
                    linkedMatchedCount = linkedMatchCount,
                    loadedLinkCount = loadedLinks,
                    unloadedLinkCount = unloadedLinks,
                    message
                };
            }
            catch (Exception ex)
            {
                Result = new { success = false, message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        private static List<Element> CollectMatches(
            Document doc,
            UIDocument uiDoc,
            View scopeView,
            string searchScope,
            bool selectedOnly,
            string inclusion,
            List<string> categories,
            List<string> familyNames,
            List<string> elementNames,
            List<string> levelNames,
            JObject boundingBox,
            string bboxMode,
            JArray parameterFilters)
        {
            IEnumerable<Element> source;
            if (selectedOnly)
            {
                if (uiDoc == null)
                    return new List<Element>();
                source = uiDoc.Selection.GetElementIds()
                    .Select(id => doc.GetElement(id))
                    .Where(e => e != null);
            }
            else
            {
                FilteredElementCollector MakeCollector()
                {
                    FilteredElementCollector collector;
                    if (string.Equals(searchScope, "AllViews", StringComparison.OrdinalIgnoreCase))
                    {
                        collector = new FilteredElementCollector(doc);
                        collector = AppendBoundingBoxFilter(collector, boundingBox, bboxMode);
                    }
                    else if (scopeView != null)
                    {
                        collector = new FilteredElementCollector(doc, scopeView.Id);
                    }
                    else
                    {
                        collector = new FilteredElementCollector(doc, doc.ActiveView.Id);
                    }

                    return collector;
                }

                FilteredElementCollector ApplyCategories(FilteredElementCollector collector)
                {
                    if (categories == null || categories.Count == 0)
                        return collector;

                    var builtIns = new List<BuiltInCategory>();
                    foreach (var name in categories)
                    {
                        if (Enum.TryParse(name, true, out BuiltInCategory builtIn)
                            && builtIn != BuiltInCategory.INVALID)
                        {
                            builtIns.Add(builtIn);
                        }
                    }

                    if (builtIns.Count == 1)
                        return collector.OfCategory(builtIns[0]);
                    if (builtIns.Count > 1)
                        return collector.WherePasses(new ElementMulticategoryFilter(builtIns));
                    return collector;
                }

                if (inclusion == "TypesAndInstances")
                {
                    var instances = ApplyCategories(MakeCollector().WhereElementIsNotElementType()).ToElements();
                    var types = ApplyCategories(new FilteredElementCollector(doc).WhereElementIsElementType()).ToElements();
                    source = instances.Concat(types);
                }
                else if (inclusion == "TypesOnly")
                {
                    source = ApplyCategories(new FilteredElementCollector(doc).WhereElementIsElementType()).ToElements();
                }
                else
                {
                    source = ApplyCategories(MakeCollector().WhereElementIsNotElementType()).ToElements();
                }
            }

            if (selectedOnly && categories != null && categories.Count > 0)
            {
                var allowed = new HashSet<string>(categories, StringComparer.OrdinalIgnoreCase);
                source = source.Where(e => allowed.Contains(PublicMcpUtils.GetBuiltInCategoryName(e)));
            }

            if (inclusion == "TypesOnly")
                source = source.Where(e => e is ElementType);
            else if (inclusion == "InstancesOnly" && selectedOnly)
                source = source.Where(e => e is not ElementType);

            return source.Where(element =>
            {
                if (!PublicMcpUtils.AnyContains(familyNames, PublicMcpUtils.GetFamilyName(element)))
                    return false;
                if (!PublicMcpUtils.AnyContains(elementNames, element.Name))
                    return false;
                if (!PublicMcpUtils.AnyContains(levelNames, PublicMcpUtils.GetLevelName(doc, element)))
                    return false;
                if (!MatchesBoundingBox(element, boundingBox, bboxMode, scopeView))
                    return false;
                if (parameterFilters != null)
                {
                    foreach (var filter in parameterFilters.OfType<JObject>())
                    {
                        if (!PublicMcpUtils.MatchesParameterFilter(
                                element,
                                filter.Value<string>("parameterName"),
                                filter.Value<string>("comparisonType"),
                                filter.Value<string>("value")))
                            return false;
                    }
                }
                return true;
            }).ToList();
        }

        private static List<Element> CollectMatchesFromLinkInView(
            Document hostDoc,
            RevitLinkInstance link,
            View scopeView,
            string inclusion,
            List<string> categories,
            List<string> familyNames,
            List<string> elementNames,
            List<string> levelNames,
            JObject boundingBox,
            string bboxMode,
            JArray parameterFilters)
        {
            var linkDoc = link.GetLinkDocument();
            if (linkDoc == null || scopeView == null)
                return new List<Element>();

            FilteredElementCollector collector = new FilteredElementCollector(hostDoc, scopeView.Id, link.Id);
            if (inclusion != "TypesOnly")
                collector = collector.WhereElementIsNotElementType();
            else
                collector = collector.WhereElementIsElementType();

            if (categories != null && categories.Count > 0)
            {
                var builtIns = new List<BuiltInCategory>();
                foreach (var name in categories)
                {
                    if (Enum.TryParse(name, true, out BuiltInCategory builtIn)
                        && builtIn != BuiltInCategory.INVALID)
                    {
                        builtIns.Add(builtIn);
                    }
                }

                if (builtIns.Count == 1)
                    collector = collector.OfCategory(builtIns[0]);
                else if (builtIns.Count > 1)
                    collector = collector.WherePasses(new ElementMulticategoryFilter(builtIns));
            }

            return collector.ToElements().Where(element =>
            {
                if (!PublicMcpUtils.AnyContains(familyNames, PublicMcpUtils.GetFamilyName(element)))
                    return false;
                if (!PublicMcpUtils.AnyContains(elementNames, element.Name))
                    return false;
                if (!PublicMcpUtils.AnyContains(levelNames, PublicMcpUtils.GetLevelName(linkDoc, element)))
                    return false;
                if (!MatchesBoundingBox(element, boundingBox, bboxMode, scopeView))
                    return false;
                if (parameterFilters != null)
                {
                    foreach (var filter in parameterFilters.OfType<JObject>())
                    {
                        if (!PublicMcpUtils.MatchesParameterFilter(
                                element,
                                filter.Value<string>("parameterName"),
                                filter.Value<string>("comparisonType"),
                                filter.Value<string>("value")))
                            return false;
                    }
                }
                return true;
            }).ToList();
        }

        private static List<string> ReadStringList(JObject input, params string[] keys)
        {
            foreach (var key in keys)
            {
                var list = input[key]?.ToObject<List<string>>();
                if (list != null && list.Count > 0)
                    return list;
            }

            return null;
        }

        private static FilteredElementCollector AppendBoundingBoxFilter(
            FilteredElementCollector collector,
            JObject boundingBox,
            string mode)
        {
            if (boundingBox == null || !TryReadOutline(boundingBox, out var outline))
                return collector;

            return string.Equals(mode, "ElementsInside", StringComparison.OrdinalIgnoreCase)
                ? collector.WherePasses(new BoundingBoxIsInsideFilter(outline))
                : collector.WherePasses(new BoundingBoxIntersectsFilter(outline));
        }

        private static bool TryReadOutline(JObject boundingBox, out Outline outline)
        {
            outline = null;
            var min = boundingBox["minXYZ"] as JObject;
            var max = boundingBox["maxXYZ"] as JObject;
            if (min == null || max == null)
                return false;

            var filterMin = new XYZ(min.Value<double>("x"), min.Value<double>("y"), min.Value<double>("z"));
            var filterMax = new XYZ(max.Value<double>("x"), max.Value<double>("y"), max.Value<double>("z"));
            if (filterMin.X >= filterMax.X || filterMin.Y >= filterMax.Y || filterMin.Z >= filterMax.Z)
                return false;

            outline = new Outline(filterMin, filterMax);
            return true;
        }

        private static bool MatchesBoundingBox(Element element, JObject boundingBox, string mode, View scopeView)
        {
            if (boundingBox == null)
                return true;

            var box = (scopeView != null ? element.get_BoundingBox(scopeView) : null)
                      ?? element.get_BoundingBox(null);
            if (box == null)
                return false;

            var min = boundingBox["minXYZ"] as JObject;
            var max = boundingBox["maxXYZ"] as JObject;
            if (min == null || max == null)
                return true;

            var filterMin = new XYZ(min.Value<double>("x"), min.Value<double>("y"), min.Value<double>("z"));
            var filterMax = new XYZ(max.Value<double>("x"), max.Value<double>("y"), max.Value<double>("z"));

            bool inside = box.Min.X >= filterMin.X && box.Min.Y >= filterMin.Y && box.Min.Z >= filterMin.Z
                          && box.Max.X <= filterMax.X && box.Max.Y <= filterMax.Y && box.Max.Z <= filterMax.Z;
            bool intersecting = box.Min.X <= filterMax.X && box.Max.X >= filterMin.X
                                && box.Min.Y <= filterMax.Y && box.Max.Y >= filterMin.Y
                                && box.Min.Z <= filterMax.Z && box.Max.Z >= filterMin.Z;

            return string.Equals(mode, "ElementsInside", StringComparison.OrdinalIgnoreCase)
                ? inside
                : intersecting;
        }

        private static object BuildAnalysis(Document doc, List<Element> matches)
        {
            var byCategory = matches
                .GroupBy(e => PublicMcpUtils.GetCategoryName(e) is { Length: > 0 } name ? name : "(none)")
                .OrderByDescending(g => g.Count())
                .Select(g => new { name = g.Key, count = g.Count() })
                .ToList();
            var byLevel = matches
                .GroupBy(e => PublicMcpUtils.GetLevelName(doc, e) is { Length: > 0 } name ? name : "(none)")
                .OrderByDescending(g => g.Count())
                .Select(g => new { name = g.Key, count = g.Count() })
                .ToList();
            var byFamily = matches
                .GroupBy(e => PublicMcpUtils.GetFamilyName(e) is { Length: > 0 } name ? name : "(none)")
                .OrderByDescending(g => g.Count())
                .Take(50)
                .Select(g => new { name = g.Key, count = g.Count() })
                .ToList();

            return new
            {
                total = matches.Count,
                byCategory,
                byLevel,
                byFamily
            };
        }

        public string GetName() => "query_model";
    }

    public class GetElementDataEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public JObject Parameters { get; private set; }
        public object Result { get; private set; }

        public void SetParameters(JObject parameters)
        {
            Parameters = parameters ?? new JObject();
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) => _resetEvent.WaitOne(timeoutMilliseconds);

        public void Execute(UIApplication app)
        {
            try
            {
                var doc = app.ActiveUIDocument.Document;
                var options = Parameters?["outputOptions"] as JObject;
                var basic = options?.Value<bool?>("basicElementInfo") ?? true;
                var includeClass = options?.Value<bool?>("elementClass") ?? false;
                var includeBox = options?.Value<bool?>("boundingBox") ?? false;
                var parameterMode = options?.Value<string>("parametersOutputType") ?? "None";
                var specificNames = options?["specificParameterNames"]?.ToObject<List<string>>();
                if (!string.Equals(parameterMode, "None", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(parameterMode, "KeyParameters", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(parameterMode, "SpecificParameters", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(parameterMode, "AllParameters", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(parameterMode, "EditableInstanceParameters", StringComparison.OrdinalIgnoreCase))
                {
                    throw new ArgumentException($"invalid ParametersOutputType: {parameterMode}");
                }
                if (string.Equals(parameterMode, "SpecificParameters", StringComparison.OrdinalIgnoreCase)
                    && (specificNames == null || specificNames.Count == 0))
                {
                    throw new ArgumentException("SpecificParameterNames must be provided when ParametersOutputType is SpecificParameters.");
                }

                var refs = new List<(long elementId, long? linkInstanceId)>();
                var elementRefs = Parameters?["elementRefs"] as JArray;
                if (elementRefs != null && elementRefs.Count > 0)
                {
                    foreach (var token in elementRefs.OfType<JObject>())
                    {
                        var elementId = token.Value<long?>("elementId");
                        if (!elementId.HasValue)
                            continue;
                        refs.Add((elementId.Value, token.Value<long?>("linkInstanceId")));
                    }
                }
                else
                {
                    var ids = Parameters?["elementIds"]?.ToObject<List<long>>() ?? new List<long>();
                    foreach (var id in ids)
                        refs.Add((id, null));
                }

                if (refs.Count == 0)
                    throw new ArgumentException("No elements to get information for.");

                var elements = new List<object>();
                foreach (var (elementId, linkInstanceId) in refs)
                {
                    Document targetDoc = doc;
                    string linkName = null;
                    if (linkInstanceId.HasValue)
                    {
                        var link = doc.GetElement(PublicMcpUtils.Id(linkInstanceId.Value)) as RevitLinkInstance;
                        if (link == null)
                        {
                            elements.Add(new
                            {
                                id = elementId,
                                linkInstanceId,
                                error = "Link instance not found"
                            });
                            continue;
                        }

                        targetDoc = link.GetLinkDocument();
                        linkName = link.Name;
                        if (targetDoc == null)
                        {
                            elements.Add(new
                            {
                                id = elementId,
                                linkInstanceId,
                                linkName,
                                error = "Linked document is unloaded"
                            });
                            continue;
                        }
                    }

                    var element = targetDoc.GetElement(PublicMcpUtils.Id(elementId));
                    if (element == null)
                    {
                        elements.Add(new
                        {
                            id = elementId,
                            linkInstanceId,
                            linkName,
                            error = "Element not found"
                        });
                        continue;
                    }

                    var item = new Dictionary<string, object>
                    {
                        ["id"] = element.Id.GetValue(),
                        ["linkInstanceId"] = linkInstanceId,
                        ["linkName"] = linkName
                    };
                    if (basic)
                    {
                        item["name"] = element.Name;
                        item["category"] = PublicMcpUtils.GetCategoryName(element);
                        item["family"] = PublicMcpUtils.GetFamilyName(element);
                        item["type"] = PublicMcpUtils.GetTypeName(targetDoc, element);
                        item["level"] = PublicMcpUtils.GetLevelName(targetDoc, element);
                    }
                    if (includeClass)
                        item["elementClass"] = element.GetType().Name;
                    if (includeBox)
                        item["boundingBox"] = PublicMcpUtils.GetBoundingBox(element);
                    if (!string.Equals(parameterMode, "None", StringComparison.OrdinalIgnoreCase))
                        item["parameters"] = PublicMcpUtils.GetParameters(element, parameterMode, specificNames);

                    elements.Add(item);
                }

                Result = new { elements };
            }
            catch (Exception ex)
            {
                Result = new { success = false, message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "get_element_data";
    }
}
