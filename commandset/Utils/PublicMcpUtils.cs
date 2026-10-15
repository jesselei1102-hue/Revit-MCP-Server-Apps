using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitMCPCommandSet.Utils
{
    internal static class PublicMcpUtils
    {
        private static readonly string[] KeyParameterNames =
        {
            "Height", "Length", "Width", "Area", "Volume", "Material", "Mark",
            "高度", "长度", "宽度", "面积", "体积", "材质", "标记"
        };

        /// <summary>
        /// Known calculated quantities — exclude even if a host reports them oddly.
        /// Writable dims (e.g. Unconnected Height) keep other names and stay included via !IsReadOnly.
        /// </summary>
        private static readonly HashSet<string> CalculatedParameterNames =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "Area", "Volume", "Perimeter", "Surface Area", "Gross Volume", "Gross Area",
                "面积", "体积", "周长", "表面积"
            };

        public static ElementId Id(long value) => ElementIdExtensions.CreateId(value);

        public static string GetCategoryName(Element element) =>
            element?.Category?.Name ?? string.Empty;

        public static string GetBuiltInCategoryName(Element element)
        {
            if (element?.Category == null)
                return string.Empty;
            return Enum.GetName(typeof(BuiltInCategory), element.Category.Id.GetIntValue())
                   ?? string.Empty;
        }

        public static string GetFamilyName(Element element)
        {
            if (element is FamilyInstance instance && instance.Symbol?.Family != null)
                return instance.Symbol.Family.Name;
            if (element is ElementType elementType)
                return elementType.FamilyName ?? string.Empty;
            return element?.get_Parameter(BuiltInParameter.ELEM_FAMILY_PARAM)?.AsValueString()
                   ?? string.Empty;
        }

        public static string GetTypeName(Document doc, Element element)
        {
            if (element is ElementType elementType)
                return elementType.Name;
            var typeId = element.GetTypeId();
            if (typeId != null && typeId != ElementId.InvalidElementId)
            {
                var type = doc.GetElement(typeId);
                if (type != null)
                    return type.Name;
            }
            return element.get_Parameter(BuiltInParameter.ELEM_TYPE_PARAM)?.AsValueString()
                   ?? element.Name
                   ?? string.Empty;
        }

        public static string GetLevelName(Document doc, Element element)
        {
            if (element is Level level)
                return level.Name;

            if (element.LevelId != null && element.LevelId != ElementId.InvalidElementId)
            {
                if (doc.GetElement(element.LevelId) is Level byId)
                    return byId.Name;
            }

            var bipList = new[]
            {
                BuiltInParameter.SCHEDULE_LEVEL_PARAM,
                BuiltInParameter.FAMILY_LEVEL_PARAM,
                BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM,
                BuiltInParameter.LEVEL_PARAM
            };
            foreach (var bip in bipList)
            {
                var parameter = element.get_Parameter(bip);
                var value = parameter?.AsValueString();
                if (!string.IsNullOrWhiteSpace(value))
                    return value;
            }

            return string.Empty;
        }

        public static object GetBoundingBox(Element element)
        {
            var view = element?.Document?.ActiveView;
            var box = (view != null ? element.get_BoundingBox(view) : null)
                      ?? element.get_BoundingBox(null);
            if (box == null)
                return null;

            return new
            {
                min = new { x = box.Min.X, y = box.Min.Y, z = box.Min.Z },
                max = new { x = box.Max.X, y = box.Max.Y, z = box.Max.Z }
            };
        }

        public static bool ContainsIgnoreCase(string source, string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return true;
            if (string.IsNullOrEmpty(source))
                return false;
            return CultureInfo.InvariantCulture.CompareInfo.IndexOf(
                source, value, CompareOptions.IgnoreCase) >= 0;
        }

        public static bool AnyContains(IList<string> filters, string source)
        {
            if (filters == null || filters.Count == 0)
                return true;
            return filters.Any(filter => ContainsIgnoreCase(source, filter));
        }

        public static Parameter FindParameter(Element element, string name)
        {
            if (element == null || string.IsNullOrWhiteSpace(name))
                return null;

            var lookup = element.LookupParameter(name);
            if (lookup != null)
                return lookup;

            if (Enum.TryParse(name, true, out BuiltInParameter builtIn))
            {
                var byBuiltIn = element.get_Parameter(builtIn);
                if (byBuiltIn != null)
                    return byBuiltIn;
            }

            if (Guid.TryParse(name, out var guid))
            {
                var byGuid = element.get_Parameter(guid);
                if (byGuid != null)
                    return byGuid;
            }

            foreach (Parameter parameter in element.Parameters)
            {
                if (string.Equals(parameter?.Definition?.Name, name, StringComparison.OrdinalIgnoreCase))
                    return parameter;
            }

            return null;
        }

        public static string GetParameterDisplay(Parameter parameter)
        {
            if (parameter == null || !parameter.HasValue)
                return null;

            var display = parameter.AsValueString();
            if (!string.IsNullOrWhiteSpace(display))
                return display;

            switch (parameter.StorageType)
            {
                case StorageType.String:
                    return parameter.AsString();
                case StorageType.Integer:
                    return parameter.AsInteger().ToString(CultureInfo.InvariantCulture);
                case StorageType.Double:
                    return parameter.AsDouble().ToString("G", CultureInfo.InvariantCulture);
                case StorageType.ElementId:
                    var id = parameter.AsElementId();
                    if (id == null || id == ElementId.InvalidElementId)
                        return null;
                    var target = parameter.Element?.Document?.GetElement(id);
                    return target?.Name ?? id.GetValue().ToString(CultureInfo.InvariantCulture);
                default:
                    return null;
            }
        }

        public static bool TryGetParameterNumber(Parameter parameter, out double value)
        {
            value = 0;
            if (parameter == null || !parameter.HasValue)
                return false;

            switch (parameter.StorageType)
            {
                case StorageType.Double:
                    value = parameter.AsDouble();
                    return true;
                case StorageType.Integer:
                    value = parameter.AsInteger();
                    return true;
                case StorageType.ElementId:
                    value = parameter.AsElementId().GetValue();
                    return true;
                default:
                    var display = GetParameterDisplay(parameter);
                    return double.TryParse(display, NumberStyles.Float, CultureInfo.InvariantCulture, out value)
                           || double.TryParse(display, NumberStyles.Float, CultureInfo.CurrentCulture, out value);
            }
        }

        public static bool MatchesParameterFilter(Element element, string parameterName, string comparisonType, string expected)
        {
            var parameter = FindParameter(element, parameterName);
            if (parameter == null && element.GetTypeId() != ElementId.InvalidElementId)
            {
                var type = element.Document.GetElement(element.GetTypeId());
                if (type != null)
                    parameter = FindParameter(type, parameterName);
            }

            if (parameter == null)
                return false;

            var comparison = (comparisonType ?? "Equals").Trim();
            var display = GetParameterDisplay(parameter) ?? string.Empty;

            switch (comparison)
            {
                case "Contains":
                    return ContainsIgnoreCase(display, expected);
                case "StartsWith":
                    return display.StartsWith(expected ?? string.Empty, StringComparison.OrdinalIgnoreCase);
                case "EndsWith":
                    return display.EndsWith(expected ?? string.Empty, StringComparison.OrdinalIgnoreCase);
                case "GreaterThan":
                    return TryGetParameterNumber(parameter, out var greater)
                           && double.TryParse(expected, NumberStyles.Float, CultureInfo.InvariantCulture, out var min)
                           && greater > min;
                case "LessThan":
                    return TryGetParameterNumber(parameter, out var less)
                           && double.TryParse(expected, NumberStyles.Float, CultureInfo.InvariantCulture, out var max)
                           && less < max;
                default:
                    if (string.Equals(display, expected, StringComparison.OrdinalIgnoreCase))
                        return true;
                    if (TryGetParameterNumber(parameter, out var number)
                        && double.TryParse(expected, NumberStyles.Float, CultureInfo.InvariantCulture, out var expectedNumber))
                    {
                        return Math.Abs(number - expectedNumber) < 1e-6;
                    }
                    return false;
            }
        }

        public static Dictionary<string, string> GetParameters(
            Element element,
            string outputType,
            IList<string> specificNames)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var mode = outputType ?? "None";
            if (string.Equals(mode, "None", StringComparison.OrdinalIgnoreCase))
                return result;

            IEnumerable<Parameter> source;
            var includeEmpty = false;
            if (string.Equals(mode, "SpecificParameters", StringComparison.OrdinalIgnoreCase))
            {
                source = (specificNames ?? Array.Empty<string>())
                    .Select(name => FindParameter(element, name))
                    .Where(parameter => parameter != null);
            }
            else if (string.Equals(mode, "KeyParameters", StringComparison.OrdinalIgnoreCase))
            {
                source = KeyParameterNames
                    .Select(name => FindParameter(element, name))
                    .Where(parameter => parameter != null);
            }
            else if (string.Equals(mode, "EditableInstanceParameters", StringComparison.OrdinalIgnoreCase))
            {
                includeEmpty = true;
                source = element.Parameters.Cast<Parameter>()
                    .Where(IsEditableInstanceParameter);
            }
            else
            {
                source = element.Parameters.Cast<Parameter>();
            }

            foreach (var parameter in source)
            {
                var name = parameter.Definition?.Name;
                if (string.IsNullOrWhiteSpace(name) || result.ContainsKey(name))
                    continue;
                var value = GetParameterDisplay(parameter);
                if (value != null)
                    result[name] = value;
                else if (includeEmpty)
                    result[name] = string.Empty;
            }

            return result;
        }

        public static bool IsEditableInstanceParameter(Parameter parameter)
        {
            if (parameter?.Definition == null || parameter.IsReadOnly)
                return false;
            if (parameter.StorageType is StorageType.None or StorageType.ElementId)
                return false;
            var name = parameter.Definition.Name;
            if (string.IsNullOrWhiteSpace(name) || CalculatedParameterNames.Contains(name))
                return false;
            return true;
        }

        public static bool TrySetParameterValue(Parameter parameter, string value, out string error)
        {
            error = null;
            if (parameter == null)
            {
                error = "Parameter not found";
                return false;
            }
            if (parameter.IsReadOnly)
            {
                error = "Parameter is read-only";
                return false;
            }

            var text = value ?? string.Empty;
            try
            {
                if (parameter.SetValueString(text))
                    return true;

                switch (parameter.StorageType)
                {
                    case StorageType.String:
                        parameter.Set(text);
                        return true;
                    case StorageType.Integer:
                        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i)
                            || int.TryParse(text, NumberStyles.Integer, CultureInfo.CurrentCulture, out i))
                        {
                            parameter.Set(i);
                            return true;
                        }
                        error = $"Cannot parse integer from '{text}'";
                        return false;
                    case StorageType.Double:
                        if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)
                            || double.TryParse(text, NumberStyles.Float, CultureInfo.CurrentCulture, out d))
                        {
                            parameter.Set(d);
                            return true;
                        }
                        error = $"Cannot parse number from '{text}'";
                        return false;
                    default:
                        error = $"Unsupported storage type {parameter.StorageType}";
                        return false;
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        public static bool IsPrintableView(View view)
        {
            if (view == null || view.IsTemplate)
                return false;
            if (view.ViewType == ViewType.Internal
                || view.ViewType == ViewType.ProjectBrowser
                || view.ViewType == ViewType.SystemBrowser
                || view.ViewType == ViewType.Undefined)
                return false;
            return view.CanBePrinted;
        }

        public static bool IsOpenableView(View view, out string error)
        {
            error = null;
            if (view == null)
            {
                error = "View was not found. Run query_model with AllViews and OST_Views category to find all views.";
                return false;
            }
            if (view.IsTemplate)
            {
                error = "Template views cannot be opened";
                return false;
            }
            if (view.ViewType is ViewType.Internal or ViewType.ProjectBrowser or ViewType.SystemBrowser)
            {
                error = "Browser or internal views cannot be opened";
                return false;
            }
            return true;
        }

        public static void RequestOpenView(UIDocument uiDoc, View view)
        {
            if (uiDoc == null)
                throw new ArgumentNullException(nameof(uiDoc));
            if (!IsOpenableView(view, out var error))
                throw new Exception(error);

            try
            {
                uiDoc.RequestViewChange(view);
            }
            catch (InvalidOperationException)
            {
                uiDoc.ActiveView = view;
            }
        }
    }
}
