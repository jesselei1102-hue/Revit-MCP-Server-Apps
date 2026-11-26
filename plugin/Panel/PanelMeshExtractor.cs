using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Host-only mesh extraction for the Agent Canvas 3D view.
    /// Walks geometry the same way the proven _render white-model OBJ exporter does:
    /// element -> get_Geometry(Options) -> GeometryInstance (SymbolGeometry + Transform)
    /// -> Solid.Faces -> Face.Triangulate -> Mesh.Vertices / Mesh.get_Triangle.
    /// Positions are feet, Z-up (Revit internal coordinates).
    /// </summary>
    internal static class PanelMeshExtractor
    {
        public const int MaxVerticesPerElement = 200_000; // was 100_000 — large curtain / stair / fixture solids
        // Full host + several links; Canvas already streams and caches the result file.
        public const int MaxVerticesPerBatch = 12_000_000;
        // Per-link cap used to cut architecture while MEP kept going.
        public const int MaxVerticesPerLink = 8_000_000;
        private const int MaxDepth = 8;
        /// <summary>Whole-view conversion budget. Idling slices keep Revit usable while this runs.</summary>
        public const int DefaultMaxElapsedMs = 600_000;

        public sealed class ExtractOptions
        {
            /// <summary>Abort the batch after this many ms (checked between elements). 0 = DefaultMaxElapsedMs.</summary>
            public int MaxElapsedMs { get; set; } = DefaultMaxElapsedMs;
            /// <summary>Skip RevitLinkInstance containers (faster HUD loads; links often dominate time).</summary>
            public bool SkipLinks { get; set; }
            /// <summary>Optional tighter per-element vertex cap for quick loads. 0 = MaxVerticesPerElement.</summary>
            public int MaxVerticesPerElementOverride { get; set; }
            /// <summary>
            /// When set (especially a View3D with an active section / scope box), geometry Options.View
            /// is bound to it so Revit returns view-clipped meshes matching what you see in that view.
            /// </summary>
            public View View { get; set; }
            /// <summary>done, total, label. Called on the Revit UI thread during extract.</summary>
            public Action<int, int, string> Progress { get; set; }
        }

        /// <summary>
        /// Cap faces triangulated per element after we decide to keep full solids.
        /// </summary>
        public const int MaxFacesPerElement = 120;
        /// <summary>MEP pipes/fittings need more faces so elbows/bends stay continuous.</summary>
        public const int MaxFacesPerMepElement = 4000;
        /// <summary>If a quick geometry walk estimates more faces than this, emit a bbox proxy instead.</summary>
        public const int SimplifyFaceEstimateThreshold = 80;
        /// <summary>Nested GeometryInstance count that triggers bbox proxy for FamilyInstance.</summary>
        public const int SimplifyInstanceThreshold = 12;

        /// <summary>
        /// Category/name heuristic only — never call get_Geometry here.
        /// A second get_Geometry + face walk was hanging the UI on some elements during Load Revit view.
        /// </summary>
        private static bool IsLikelyGlazedElement(Element element)
        {
            if (element == null)
                return false;

            string cat = element.Category?.Name ?? string.Empty;
            // Only real windows and curtain panels. Matching "curtain" or a glass word in the
            // name painted whole walls and mullions, because a link category shares one flag.
            switch (BicOf(element))
            {
                case BuiltInCategory.OST_Windows:
                    return true;
                case BuiltInCategory.OST_CurtainWallPanels:
                    return CurtainPanelIsGlass(element);
            }

            if (string.Equals(cat, "Windows", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(cat, "窗", StringComparison.Ordinal) || string.Equals(cat, "窗户", StringComparison.Ordinal)) return true;
            if (cat.IndexOf("Curtain Panel", StringComparison.OrdinalIgnoreCase) >= 0
                || cat.IndexOf("幕墙嵌板", StringComparison.Ordinal) >= 0
                || cat.IndexOf("幕墙面板", StringComparison.Ordinal) >= 0)
                return CurtainPanelIsGlass(element);
            return false;
        }

        /// <summary>Glass curtain panels are translucent. Opaque spandrels stay solid.</summary>
        private static bool CurtainPanelIsGlass(Element element)
        {
            if (element?.Document == null)
                return false;
            try
            {
                foreach (ElementId id in element.GetMaterialIds(false))
                {
                    if (element.Document.GetElement(id) is Material material && MaterialIsGlass(material))
                        return true;
                }
            }
            catch (Exception) { /* type materials below */ }

            try
            {
                ElementId typeId = element.GetTypeId();
                if (typeId != null && typeId != ElementId.InvalidElementId
                    && element.Document.GetElement(typeId) is Element type)
                {
                    foreach (ElementId id in type.GetMaterialIds(false))
                    {
                        if (element.Document.GetElement(id) is Material material && MaterialIsGlass(material))
                            return true;
                    }
                }
            }
            catch (Exception) { /* not glass */ }

            string name = element.Name ?? string.Empty;
            if (name.IndexOf("glass", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("glaz", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("玻璃", StringComparison.Ordinal) >= 0) return true;
            return false;
        }

        private static bool MaterialIsGlass(Material material)
        {
            if (material == null)
                return false;
            try
            {
                if (material.Transparency >= 8)
                    return true;
            }
            catch (Exception) { /* name only */ }
            string name = material.Name ?? string.Empty;
            if (name.IndexOf("glass", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("glaz", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("玻璃", StringComparison.Ordinal) >= 0) return true;
            return false;
        }

        /// <summary>
        /// Closed room/space/area solids should stay translucent in the canvas or they occlude the model.
        /// </summary>
        private static bool IsLikelyVolumeElement(Element element)
        {
            if (element == null)
                return false;

            if (element is SpatialElement)
                return true;

            string cat = element.Category?.Name ?? string.Empty;
            if (string.Equals(cat, "Rooms", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(cat, "Spaces", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(cat, "Areas", StringComparison.OrdinalIgnoreCase)) return true;
            if (cat.IndexOf("tag", StringComparison.OrdinalIgnoreCase) >= 0) return false;
            if (cat.IndexOf("separat", StringComparison.OrdinalIgnoreCase) >= 0) return false;
            if (cat.IndexOf("Room", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Space", StringComparison.OrdinalIgnoreCase) >= 0
                && cat.IndexOf("Type", StringComparison.OrdinalIgnoreCase) < 0
                && cat.IndexOf("Setting", StringComparison.OrdinalIgnoreCase) < 0)
                return true;
            return false;
        }

        /// <summary>Room/Space label as "NAME NUMBER" so the canvas list matches Revit room tags.</summary>
        private static string SpatialDisplayName(Element element)
        {
            if (element is SpatialElement spatial)
            {
                string number = null;
                try { number = spatial.Number; }
                catch (Exception) { number = null; }
                string name = null;
                try
                {
                    Parameter p = spatial.get_Parameter(BuiltInParameter.ROOM_NAME);
                    name = p?.AsString();
                }
                catch (Exception) { name = null; }
                if (string.IsNullOrWhiteSpace(name))
                    name = spatial.Name;
                if (string.IsNullOrWhiteSpace(number))
                    return name ?? string.Empty;
                if (string.IsNullOrWhiteSpace(name))
                    return number;
                return (name + " " + number).Trim();
            }

            return element?.Name ?? string.Empty;
        }

        // Max batch was raised; SupportedCategories is no longer used in full-view mode (kept for reference).

        /// <summary>
        /// Full-view mode: take all non-annotation, non-type model elements in the view.
        /// Annotation/Symbolic categories (TextNote, Dimension, AreaTag, ViewSymbols...) are filtered out
        /// by ElementCategoryClass = Model here, so door/window/curtain-wall/furniture/etc. are included.
        /// </summary>
        public static IList<Element> ResolveTargets(Document doc, View view, IList<long> requestedIds)
        {
            if (doc == null)
                return new List<Element>();

            if (requestedIds != null && requestedIds.Count > 0)
            {
                var requested = new List<Element>();
                foreach (long idValue in requestedIds)
                {
                    ElementId id;
                    try { id = PanelElementIds.Create(idValue); }
                    catch (Exception) { continue; }
                    Element element = doc.GetElement(id);
                    if (element != null)
                        requested.Add(element);
                }
                return requested;
            }

            var modelElements = new List<Element>();
            CollectModelElements(doc, view, modelElements);
            // Rooms/Spaces are often absent from 3D view collectors (not "visible" in 3D) and their
            // CategoryType can be Internal — always append placed spatial volumes so the canvas can
            // colour / pick them like walls.
            CollectSpatialVolumes(doc, modelElements);
            return modelElements;
        }

        private static void CollectModelElements(Document doc, View view, IList<Element> output)
        {
            if (doc == null || output == null)
                return;

            var candidates = view != null
                ? new FilteredElementCollector(doc, view.Id)
                : new FilteredElementCollector(doc);

            foreach (Element candidate in candidates.WhereElementIsNotElementType())
            {
                if (candidate == null)
                    continue;

                Category category = candidate.Category;
                if (category == null)
                    continue;

                // Keep physical model categories only; annotation/symbolic categories have no usable solid mesh.
                if (category.CategoryType != CategoryType.Model)
                    continue;

                if (ShouldSkipPanelElement(candidate))
                    continue;

                output.Add(candidate);
            }
        }

        /// <summary>
        /// Categories that pollute the Canvas (RPC trees → diamond proxies) without helping BIM review.
        /// Built-in ids first — Category.Name is localized (植物 / 环境).
        /// </summary>
        private static bool ShouldSkipPanelElement(Element element)
        {
            if (IsOpeningElement(element))
                return true;

            switch (BicOf(element))
            {
                case BuiltInCategory.OST_Planting:
                case BuiltInCategory.OST_Entourage:
                case BuiltInCategory.OST_Parking:
                    return true;
            }

            string cat = element?.Category?.Name ?? string.Empty;
            if (cat.IndexOf("Planting", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Entourage", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Parking", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("RPC", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private static BuiltInCategory BicOf(Element element)
        {
            try
            {
                if (element?.Category == null)
                    return BuiltInCategory.INVALID;
                return (BuiltInCategory)PanelElementIds.GetValue(element.Category.Id);
            }
            catch (Exception)
            {
                return BuiltInCategory.INVALID;
            }
        }

        /// <summary>
        /// Shell, then MEP, then links, then everything else.
        /// A time budget must not drop elbows or the linked building in favour of furniture.
        /// </summary>
        private static int PanelExtractRank(Element element)
        {
            if (element is RevitLinkInstance)
                return 2;
            if (IsMepElement(element))
                return 1;

            // Rooms / Spaces before links — otherwise a full-building link budget leaves only 0–1 volumes.
            if (IsLikelyVolumeElement(element))
                return 0;

            switch (BicOf(element))
            {
                case BuiltInCategory.OST_Walls:
                case BuiltInCategory.OST_Floors:
                case BuiltInCategory.OST_Roofs:
                case BuiltInCategory.OST_Ceilings:
                case BuiltInCategory.OST_Stairs:
                case BuiltInCategory.OST_StairsRailing:
                case BuiltInCategory.OST_Ramps:
                case BuiltInCategory.OST_Columns:
                case BuiltInCategory.OST_StructuralColumns:
                case BuiltInCategory.OST_StructuralFraming:
                case BuiltInCategory.OST_CurtainWallPanels:
                case BuiltInCategory.OST_CurtainWallMullions:
                case BuiltInCategory.OST_Rooms:
                case BuiltInCategory.OST_MEPSpaces:
                case BuiltInCategory.OST_Areas:
                    return 0;
                case BuiltInCategory.OST_Doors:
                case BuiltInCategory.OST_Windows:
                    return 2;
                case BuiltInCategory.OST_Furniture:
                case BuiltInCategory.OST_FurnitureSystems:
                case BuiltInCategory.OST_Casework:
                    return 5;
                default:
                    return 4;
            }
        }

        /// <summary>
        /// Append placed Rooms and Spaces. They rarely appear in a 3D view's collector, and
        /// get_Geometry is often empty — EmitElement falls back to a bounding-box volume proxy.
        /// </summary>
        private static void CollectSpatialVolumes(Document doc, IList<Element> output)
        {
            if (doc == null || output == null)
                return;

            var seen = new HashSet<long>();
            foreach (Element existing in output)
            {
                if (existing == null)
                    continue;
                try { seen.Add(PanelElementIds.GetValue(existing.Id)); }
                catch (Exception) { /* ignore */ }
            }

            void AddCategory(BuiltInCategory bic)
            {
                IList<Element> found;
                try
                {
                    found = new FilteredElementCollector(doc)
                        .OfCategory(bic)
                        .WhereElementIsNotElementType()
                        .ToElements();
                }
                catch (Exception)
                {
                    return;
                }

                foreach (Element candidate in found)
                {
                    if (candidate == null)
                        continue;
                    long id;
                    try { id = PanelElementIds.GetValue(candidate.Id); }
                    catch (Exception) { continue; }
                    if (!seen.Add(id))
                        continue;
                    // Skip unplaced rooms (no location / no bbox). Prefer a bbox check —
                    // some placed rooms report a null Location but still have a solid extent.
                    try
                    {
                        BoundingBoxXYZ box = candidate.get_BoundingBox(null);
                        if (box == null && candidate.Location == null)
                            continue;
                        if (candidate is SpatialElement spatial && spatial.Area <= 0 && box == null)
                            continue;
                    }
                    catch (Exception)
                    {
                        continue;
                    }
                    output.Add(candidate);
                }
            }

            AddCategory(BuiltInCategory.OST_Rooms);
            AddCategory(BuiltInCategory.OST_MEPSpaces);
        }

        public readonly struct ExtractTick
        {
            public ExtractTick(int done, int total, string label)
            {
                Done = done;
                Total = total;
                Label = label;
            }

            public int Done { get; }
            public int Total { get; }
            public string Label { get; }
        }

        /// <summary>
        /// One conversion that can be pumped in short slices. Revit API work stays on the
        /// Revit thread; the caller returns between slices so the UI can paint and take input.
        /// </summary>
        public sealed class ExtractSession : IDisposable
        {
            readonly Document _doc;
            readonly IEnumerator<ExtractTick> _steps;
            readonly WorkClock _clock;
            bool _completed;

            internal ExtractSession(Document doc, PanelMeshResult result, int total, IEnumerable<ExtractTick> steps, WorkClock clock)
            {
                _doc = doc;
                Result = result;
                Total = total;
                _steps = steps.GetEnumerator();
                _clock = clock;
            }

            public PanelMeshResult Result { get; }
            public int Total { get; }
            public int Done { get; private set; }
            public string Label { get; private set; }
            public bool Completed => _completed;

            public bool IsDocumentValid
            {
                get
                {
                    try { return _doc != null && _doc.IsValidObject; }
                    catch (Exception) { return false; }
                }
            }

            /// <summary>
            /// Convert until this slice has used the budget, or the job finishes.
            /// Returns true when more elements remain. Always completes at least one step.
            /// </summary>
            public bool Step(int budgetMs)
            {
                if (_completed)
                    return false;
                if (budgetMs < 1)
                    budgetMs = 1;
                _clock.BeginSlice();
                try
                {
                    while (true)
                    {
                        if (!_steps.MoveNext())
                        {
                            _completed = true;
                            return false;
                        }

                        ExtractTick tick = _steps.Current;
                        Done = tick.Done;
                        Label = tick.Label;
                        if (_clock.SliceMilliseconds >= budgetMs)
                            return true;
                    }
                }
                finally
                {
                    _clock.EndSlice();
                }
            }

            public void Drain()
            {
                while (Step(int.MaxValue)) { }
            }

            public void Dispose()
            {
                _steps.Dispose();
            }
        }

        internal sealed class WorkClock
        {
            readonly System.Diagnostics.Stopwatch _slice = new System.Diagnostics.Stopwatch();
            long _total;

            public long Milliseconds => _total + _slice.ElapsedMilliseconds;
            public long SliceMilliseconds => _slice.ElapsedMilliseconds;

            public void BeginSlice() => _slice.Restart();

            public void EndSlice()
            {
                _total += _slice.ElapsedMilliseconds;
                _slice.Reset();
            }
        }

        public static PanelMeshResult Extract(Document doc, IList<Element> elements, ExtractOptions extractOptions = null)
        {
            using (ExtractSession session = StartSession(doc, elements, extractOptions))
            {
                session.Drain();
                return session.Result;
            }
        }

        public static ExtractSession StartSession(Document doc, IList<Element> elements, ExtractOptions extractOptions = null)
        {
            extractOptions ??= new ExtractOptions();
            int maxElapsedMs = extractOptions.MaxElapsedMs > 0
                ? extractOptions.MaxElapsedMs
                : DefaultMaxElapsedMs;
            var result = new PanelMeshResult();
            var clock = new WorkClock();
            var ordered = (elements ?? new List<Element>())
                .Where(e => e != null)
                .OrderBy(PanelExtractRank)
                .ToList();
            IEnumerable<ExtractTick> steps = ExtractSteps(doc, ordered, extractOptions, result, maxElapsedMs, () => clock.Milliseconds);
            return new ExtractSession(doc, result, ordered.Count, steps, clock);
        }

        static IEnumerable<ExtractTick> ExtractSteps(
            Document doc,
            List<Element> ordered,
            ExtractOptions extractOptions,
            PanelMeshResult result,
            int maxElapsedMs,
            Func<long> elapsed)
        {
            ExtractTick Tick(int done, int total, string label)
            {
                extractOptions.Progress?.Invoke(done, total, label);
                return new ExtractTick(done, total, label);
            }

            // Do NOT assign Options.View — that replaces DetailLevel with the view's (often Coarse)
            // and fittings come back with no solid. Fine is only for MEP; the rest stays Medium.
            var mediumOptions = new Options
            {
                DetailLevel = ViewDetailLevel.Medium,
                IncludeNonVisibleObjects = false,
                ComputeReferences = false,
            };
            var fineOptions = new Options
            {
                DetailLevel = ViewDetailLevel.Fine,
                IncludeNonVisibleObjects = false,
                ComputeReferences = false,
            };

            View view = extractOptions.View;
            bool sectionBoxActive = false;
            if (view is View3D view3d)
            {
                try { sectionBoxActive = view3d.IsSectionBoxActive; }
                catch (Exception) { sectionBoxActive = false; }
            }

            CutContext cutContext = BuildCutContext(doc, view, sectionBoxActive);
            result.ClientSectionClip = sectionBoxActive && cutContext.Planes.Count >= 6;

            PanelService.Instance.WritePanelLog(
                $"Extract start count={ordered?.Count ?? 0} skipLinks={extractOptions.SkipLinks} maxMs={maxElapsedMs} view={view?.Name ?? "(none)"} sectionBox={sectionBoxActive} clientClip={result.ClientSectionClip} cutPlanes={cutContext.Planes?.Count ?? 0}");
            SymbolCacheHits = 0;
            SymbolCacheMisses = 0;
            SymbolMeshes.Clear();
            yield return Tick(0, ordered.Count, "Starting");

            int index = 0;
            foreach (Element element in ordered)
            {
                index++;
                if (!DocumentStillOpen(doc))
                    throw new InvalidOperationException("The document closed during conversion.");

                if (element == null)
                {
                    result.SkippedElements++;
                    yield return Tick(index, ordered.Count, "Model");
                    continue;
                }

                if (elapsed() > maxElapsedMs)
                {
                    result.Truncated = true;
                    result.SkippedElements += Math.Max(0, ordered.Count - index + 1);
                    PanelService.Instance.WritePanelLog(
                        $"Extract time-budget hit at {index}/{ordered.Count} elapsedMs={elapsed()}");
                    yield return Tick(index, ordered.Count, "Time budget");
                    break;
                }

                if (result.TotalVertices >= MaxVerticesPerBatch)
                {
                    result.Truncated = true;
                    result.SkippedElements++;
                    yield return Tick(index, ordered.Count, element.Category?.Name ?? "Model");
                    continue;
                }

                if (element is RevitLinkInstance linkInstance)
                {
                    if (extractOptions.SkipLinks)
                    {
                        result.SkippedElements++;
                        yield return Tick(index, ordered.Count, "Link");
                        continue;
                    }

                    long t0 = elapsed();
                    PanelService.Instance.WritePanelLog("Extract link start id=" + PanelElementIds.GetValue(linkInstance.Id));
                    foreach (ExtractTick linkTick in ExtractLinkSteps(
                        doc, linkInstance, mediumOptions, fineOptions, result, cutContext, null, 0, elapsed, maxElapsedMs, Tick))
                        yield return linkTick;
                    PanelService.Instance.WritePanelLog(
                        $"Extract link done id={PanelElementIds.GetValue(linkInstance.Id)} verts={result.TotalVertices} linkMs={elapsed() - t0} elapsedMs={elapsed()}");
                    continue;
                }

                long elementId = 0;
                try { elementId = PanelElementIds.GetValue(element.Id); } catch { elementId = 0; }
                long before = elapsed();
                Options elementOptions = NeedsFineGeometry(element) ? fineOptions : mediumOptions;
                EmitElement(element, elementId, element.Category?.Name, SpatialDisplayName(element),
                    Transform.Identity, elementOptions, result, cutContext);
                long took = elapsed() - before;
                if (took > 2000)
                {
                    PanelService.Instance.WritePanelLog(
                        $"Extract slow element id={elementId} cat={element.Category?.Name} ms={took}");
                }

                yield return Tick(index, ordered.Count, element.Category?.Name ?? element.Name ?? "Model");
            }

            int cutElements = 0;
            int cutIndices = 0;
            foreach (PanelMeshElementInfo info in result.Elements)
            {
                if (info.CutIndexCount <= 0)
                    continue;
                cutElements++;
                cutIndices += info.CutIndexCount;
            }

            if (cutContext.Planes != null)
            {
                foreach ((XYZ n, XYZ o) in cutContext.Planes)
                {
                    result.CutPlanes.Add((float)n.X);
                    result.CutPlanes.Add((float)n.Y);
                    result.CutPlanes.Add((float)n.Z);
                    result.CutPlanes.Add((float)o.X);
                    result.CutPlanes.Add((float)o.Y);
                    result.CutPlanes.Add((float)o.Z);
                }
            }

            if (sectionBoxActive && view is View3D clipView)
            {
                try
                {
                    BoundingBoxXYZ box = clipView.GetSectionBox();
                    if (box != null)
                        CollectSectionBoxCorners(box, result.SectionBoxCorners);
                }
                catch (Exception) { /* planes alone are enough to clip */ }
            }

            PanelService.Instance.WritePanelLog(
                $"Extract done elements={result.Elements.Count} skipped={result.SkippedElements} verts={result.TotalVertices} elapsedMs={elapsed()} truncated={result.Truncated} cutElements={cutElements} cutIndices={cutIndices} cutFacesSeen={cutContext.FacesDeferred} symbolHits={SymbolCacheHits} symbolMisses={SymbolCacheMisses}");

            foreach (ExtractTick levelTick in AssignLevelTicks(doc, result, Tick))
                yield return levelTick;
        }

        static bool DocumentStillOpen(Document doc)
        {
            try { return doc != null && doc.IsValidObject; }
            catch (Exception) { return false; }
        }

        static IEnumerable<ExtractTick> AssignLevelTicks(
            Document doc,
            PanelMeshResult result,
            Func<int, int, string, ExtractTick> tick)
        {
            if (doc == null || result == null)
                yield break;

            List<Level> levels;
            try
            {
                levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();
            }
            catch (Exception)
            {
                yield break;
            }

            foreach (Level level in levels)
                result.Levels.Add(new PanelMeshLevel { Id = PanelElementIds.GetValue(level.Id), Name = level.Name, Elevation = level.Elevation });
            if (levels.Count == 0)
                yield break;

            var levelIds = new HashSet<long>(result.Levels.Select(l => l.Id));
            int count = result.Elements.Count;
            int n = 0;
            foreach (PanelMeshElementInfo info in result.Elements)
            {
                n++;
                try
                {
                    Element element = doc.GetElement(PanelElementIds.Create(info.ElementId));
                    if (element == null || element is RevitLinkInstance)
                    {
                        // still yield below
                    }
                    else
                    {
                        ElementId levelId = element.LevelId;
                        if (levelId != null && levelId != ElementId.InvalidElementId && levelIds.Contains(PanelElementIds.GetValue(levelId)))
                            info.LevelId = PanelElementIds.GetValue(levelId);
                        else
                        {
                            BoundingBoxXYZ box = element.get_BoundingBox(null);
                            if (box != null)
                            {
                                double z = box.Min.Z + 0.5;
                                Level below = levels.LastOrDefault(l => l.Elevation <= z) ?? levels[0];
                                info.LevelId = PanelElementIds.GetValue(below.Id);
                            }
                        }
                    }
                }
                catch (Exception)
                {
                    // one odd element must not lose the whole level table
                }

                if (n == count || n % 40 == 0)
                    yield return tick(n, count, "Levels");
            }
        }


        /// <summary>
        /// Recursively expands a linked model, treating each nested link inside a link as a
        /// sub-container (depth-limited so pathological chains cannot blow the stack).
        /// Every emitted mesh carries the host link instance's element id.
        /// Yields between elements so a long link does not hold the Revit window.
        /// </summary>
        private static IEnumerable<ExtractTick> ExtractLinkSteps(
            Document hostDocument,
            RevitLinkInstance linkInstance,
            Options mediumOptions,
            Options fineOptions,
            PanelMeshResult result,
            CutContext cutContext,
            Transform parentTransform,
            int depth,
            Func<long> elapsed,
            int maxElapsedMs,
            Func<int, int, string, ExtractTick> tick)
        {
            const int MaxLinkDepth = 3;
            if (linkInstance == null || depth > MaxLinkDepth)
                yield break;

            Document linkedDoc = null;
            try { linkedDoc = linkInstance.GetLinkDocument(); }
            catch (Exception) { linkedDoc = null; }

            if (linkedDoc == null)
            {
                // Link not loaded — nothing to draw.
                result.SkippedElements++;
                yield break;
            }

            Transform linkTransform = Transform.Identity;
            try { linkTransform = linkInstance.GetTotalTransform(); }
            catch (Exception) { try { linkTransform = linkInstance.GetTransform(); } catch { } }

            if (parentTransform != null && !parentTransform.IsIdentity)
                linkTransform = parentTransform.Multiply(linkTransform);

            long hostElementId = PanelElementIds.GetValue(linkInstance.Id);
            string linkName = linkInstance.Name ?? string.Empty;

            // Emit nested link containers first so they render behind their content (painter's order is not guaranteed, so order rarely matters).
            var nestedLinks = new List<RevitLinkInstance>();
            var nestedElements = new List<Element>();
            var candidates = new FilteredElementCollector(linkedDoc).WhereElementIsNotElementType();
            foreach (Element candidate in candidates)
            {
                if (candidate == null || candidate.Category == null)
                    continue;

                if (candidate is RevitLinkInstance nestedLink)
                {
                    nestedLinks.Add(nestedLink);
                    continue;
                }

                if (candidate.Category.CategoryType != CategoryType.Model)
                    continue;

                if (ShouldSkipPanelElement(candidate))
                    continue;

                nestedElements.Add(candidate);
            }

            // One contiguous mesh per category so windows can be glass while walls stay solid.
            // Rank within a category still prefers shell before furniture if the budget runs out.
            nestedElements.Sort((a, b) =>
            {
                int byRank = PanelExtractRank(a).CompareTo(PanelExtractRank(b));
                if (byRank != 0) return byRank;
                return string.Compare(a.Category?.Name, b.Category?.Name, StringComparison.Ordinal);
            });

            foreach (RevitLinkInstance nested in nestedLinks)
            {
                foreach (ExtractTick nestedTick in ExtractLinkSteps(
                    hostDocument, nested, mediumOptions, fineOptions, result, cutContext, linkTransform, depth + 1, elapsed, maxElapsedMs, tick))
                    yield return nestedTick;
            }

            int linkBaseVertex = (int)result.TotalVertices;
            long linkStart = elapsed();
            const int LinkTimeBudgetMs = 480_000;
            CutContext linkCut = cutContext?.WithDocument(linkedDoc);

            PanelMeshElementInfo bucket = null;
            string bucketCat = null;
            int bucketStartV = 0;
            long bucketStartI = 0;

            void CloseBucket()
            {
                if (bucket == null)
                    return;
                bucket.VertexCount = (int)result.TotalVertices - bucketStartV;
                bucket.IndexCount = (int)(result.TotalIndices - bucketStartI);
                if (bucket.VertexCount > 0 && bucket.IndexCount > 0)
                {
                    bucket.FirstVertex = bucketStartV;
                    bucket.FirstIndex = (int)bucketStartI;
                    PromoteCutIndicesFromPlanes(result, bucket, linkCut ?? cutContext);
                    result.Elements.Add(bucket);
                }
                bucket = null;
            }

            int innerIndex = 0;
            int innerTotal = nestedElements.Count;
            foreach (Element inner in nestedElements)
            {
                innerIndex++;
                if (!DocumentStillOpen(hostDocument))
                    throw new InvalidOperationException("The document closed during conversion.");

                if (result.TotalVertices >= MaxVerticesPerBatch
                    || (int)result.TotalVertices - linkBaseVertex >= MaxVerticesPerLink)
                {
                    result.Truncated = true;
                    yield return tick(innerIndex, innerTotal, linkName);
                    break;
                }

                if (elapsed() - linkStart > LinkTimeBudgetMs || elapsed() > maxElapsedMs)
                {
                    result.Truncated = true;
                    PanelService.Instance.WritePanelLog(
                        $"Extract link time-budget id={hostElementId} ms={elapsed() - linkStart}");
                    yield return tick(innerIndex, innerTotal, linkName);
                    break;
                }

                if (IsOpeningElement(inner))
                {
                    yield return tick(innerIndex, innerTotal, linkName);
                    continue;
                }

                if (inner is FamilyInstance)
                {
                    CloseBucket();
                    EmitLinkedInstance(inner, linkName, hostElementId, linkTransform, fineOptions, mediumOptions, result, linkCut);
                    yield return tick(innerIndex, innerTotal, linkName);
                    continue;
                }

                string cat = inner.Category?.Name ?? "Model";
                if (bucket == null || !string.Equals(cat, bucketCat, StringComparison.Ordinal))
                {
                    CloseBucket();
                    bucketCat = cat;
                    bucketStartV = (int)result.TotalVertices;
                    bucketStartI = result.TotalIndices;
                    bucket = new PanelMeshElementInfo
                    {
                        ElementId = hostElementId,
                        Name = linkName,
                        Category = cat,
                        IsLink = true,
                        LinkInstanceId = hostElementId,
                        MeshKey = hostElementId + "|" + cat,
                        IsGlazed = IsLikelyGlazedElement(inner) || IsLikelyVolumeElement(inner),
                        ModelName = linkName,
                    };
                }

                try
                {
                    bool mep = NeedsFineGeometry(inner);
                    bool volume = IsLikelyVolumeElement(inner);
                    GeometryElement geometry = null;
                    try { geometry = inner.get_Geometry(mep ? fineOptions : mediumOptions); }
                    catch (Exception) { geometry = null; }

                    if (geometry == null)
                    {
                        if (volume)
                            EmitBoundingBoxProxy(inner, linkTransform, result, bucket);
                    }
                    else
                    {
                        linkCut?.BeginElement();
                        bucket.HighDetail = mep;
                        EmitGeometryElement(geometry, linkTransform, 0, result, bucket, linkCut, MaxVerticesPerLink);
                        FlushDeferredCuts(result, bucket, linkCut, MaxVerticesPerLink);
                        bucket.HighDetail = false;
                    }
                }
                catch (Exception) { /* one bad link element must not kill the rest */ }

                yield return tick(innerIndex, innerTotal, linkName);
            }

            CloseBucket();
            if (innerTotal > 0)
                yield return tick(innerTotal, innerTotal, linkName);
        }

        private static void EmitLinkedInstance(
            Element inner,
            string linkName,
            long hostElementId,
            Transform linkTransform,
            Options fineOptions,
            Options mediumOptions,
            PanelMeshResult result,
            CutContext linkCut)
        {
            long id = 0;
            try { id = PanelElementIds.GetValue(inner.Id); }
            catch (Exception) { id = 0; }

            int startV = (int)result.TotalVertices;
            long startI = result.TotalIndices;
            bool fine = NeedsFineGeometry(inner);
            var info = new PanelMeshElementInfo
            {
                ElementId = id,
                Name = inner.Name ?? string.Empty,
                Category = inner.Category?.Name ?? string.Empty,
                IsLink = true,
                LinkInstanceId = hostElementId,
                MeshKey = hostElementId + ":" + id,
                IsGlazed = IsLikelyGlazedElement(inner)
                    || (IsLighting(inner) && ElementHasGlassMaterial(inner)),
                HighDetail = fine || IsRailingElement(inner),
                KeepSolid = IsRailingElement(inner),
                TessellationLod = IsLighting(inner) ? 1.0 : 0,
                ModelName = linkName,
            };
            FillIdentity(info, inner, linkName);

            GeometryElement geometry = null;
            try { geometry = inner.get_Geometry(fine ? fineOptions : mediumOptions); }
            catch (Exception) { geometry = null; }
            if (geometry == null)
                return;

            try
            {
                linkCut?.BeginElement();
                EmitGeometryElement(geometry, linkTransform, 0, result, info, linkCut, -1);
                FlushDeferredCuts(result, info, linkCut, -1);
            }
            catch (Exception)
            {
                return;
            }

            info.VertexCount = (int)result.TotalVertices - startV;
            info.IndexCount = (int)(result.TotalIndices - startI);
            if (info.VertexCount <= 0 || info.IndexCount <= 0)
                return;
            info.FirstVertex = startV;
            info.FirstIndex = (int)startI;
            result.Elements.Add(info);
        }

        private static void EmitElement(
            Element element,
            long elementId,
            string categoryName,
            string elementName,
            Transform transform,
            Options options,
            PanelMeshResult result,
            CutContext cutContext)
        {
            var info = new PanelMeshElementInfo
            {
                ElementId = elementId,
                Name = elementName ?? string.Empty,
                Category = categoryName,
            };
            // Volumes reuse IsGlazed in the payload so older panel pages still treat them as translucent.
            // Pendant art-glass shades need the glass material flag or they draw as solid MEP clay.
            info.IsGlazed = IsLikelyGlazedElement(element) || IsLikelyVolumeElement(element)
                || (IsLighting(element) && ElementHasGlassMaterial(element));
            info.HighDetail = NeedsFineGeometry(element) || IsRailingElement(element);
            info.KeepSolid = IsHostFabric(element) || IsRailingElement(element);
            info.TessellationLod = IsLighting(element) ? 1.0 : 0;
            FillIdentity(info, element, element?.Document?.Title);
            info.DisplayColor = ResolveDisplayColor(cutContext?.Doc ?? element?.Document, cutContext?.View, element);

            int baseVertex = (int)result.TotalVertices;
            long baseIndex = result.TotalIndices;
            cutContext?.BeginElement();

            try
            {
                GeometryElement geometry = null;
                try { geometry = element.get_Geometry(options); }
                catch (Exception) { geometry = null; }

                bool isVolume = IsLikelyVolumeElement(element);

                // Rooms/Spaces usually have no usable get_Geometry solid — emit a translucent bbox volume.
                if (geometry == null)
                {
                    if (isVolume && EmitBoundingBoxProxy(element, transform ?? Transform.Identity, result, info))
                    {
                        info.Simplified = true;
                        info.VertexCount = (int)(result.TotalVertices - baseVertex);
                        info.IndexCount = (int)(result.TotalIndices - baseIndex);
                        info.FirstVertex = baseVertex;
                        info.FirstIndex = (int)baseIndex;
                        result.Elements.Add(info);
                        PanelService.Instance.WritePanelLog(
                            $"Extract volume proxy id={elementId} cat={categoryName} reason=no-geometry");
                    }
                    else
                    {
                        result.SkippedElements++;
                    }
                    return;
                }

                // Active simplify: keep the element (pickable) but replace insane meshes with a bbox proxy.
                // Example: Generic Model 639100 = "_Rigged+6700_...Robot+++Faceplate" — tiny bbox, huge nest.
                string simplifyReason = null;
                if (ShouldSimplifyToProxy(element, geometry, out simplifyReason) || isVolume)
                {
                    // Prefer bbox for spatial volumes even when a thin geometry object exists.
                    string reason = isVolume ? "spatial-volume" : simplifyReason;
                    if (EmitBoundingBoxProxy(element, transform ?? Transform.Identity, result, info))
                    {
                        info.Simplified = true;
                        if (!isVolume)
                            result.Truncated = true;
                        PanelService.Instance.WritePanelLog(
                            $"Extract simplified id={elementId} cat={categoryName} reason={reason} proxy=bbox");
                    }
                    else
                    {
                        result.SkippedElements++;
                        return;
                    }
                }
                else
                {
                    EmitGeometryElement(geometry, transform ?? Transform.Identity, 0, result, info, cutContext);
                    FlushDeferredCuts(result, info, cutContext, -1);
                }

                info.VertexCount = (int)(result.TotalVertices - baseVertex);
                info.IndexCount = (int)(result.TotalIndices - baseIndex);

                if (info.VertexCount > 0 && info.IndexCount > 0)
                {
                    info.FirstVertex = baseVertex;
                    info.FirstIndex = (int)baseIndex;
                    PromoteCutIndicesFromPlanes(result, info, cutContext);
                    result.Elements.Add(info);
                }
                else if (isVolume && EmitBoundingBoxProxy(element, transform ?? Transform.Identity, result, info))
                {
                    // Geometry walk produced nothing — still show the room as a volume.
                    info.Simplified = true;
                    info.VertexCount = (int)(result.TotalVertices - baseVertex);
                    info.IndexCount = (int)(result.TotalIndices - baseIndex);
                    info.FirstVertex = baseVertex;
                    info.FirstIndex = (int)baseIndex;
                    result.Elements.Add(info);
                    PanelService.Instance.WritePanelLog(
                        $"Extract volume proxy id={elementId} cat={categoryName} reason=empty-geometry");
                }
                else
                {
                    result.Positions.RemoveRange(baseVertex * 3, (int)((result.TotalVertices - baseVertex) * 3));
                    result.Indices.RemoveRange((int)baseIndex, (int)(result.TotalIndices - baseIndex));
                    result.SkippedElements++;
                }
            }
            catch (Exception)
            {
                result.Positions.RemoveRange(baseVertex * 3, (int)((result.TotalVertices - baseVertex) * 3));
                result.Indices.RemoveRange((int)baseIndex, (int)(result.TotalIndices - baseIndex));
                result.SkippedElements++;
            }
        }

        /// <summary>
        /// Reclassify already-emitted triangles: any tri whose vertices sit on a clip plane
        /// is moved to the trailing cut index range. Works even when Face graphics-style
        /// / PlanarFace matching misses view-clipped caps.
        /// </summary>
        private static void PromoteCutIndicesFromPlanes(
            PanelMeshResult result,
            PanelMeshElementInfo info,
            CutContext cutContext)
        {
            if (result == null || info == null || cutContext == null || !cutContext.Enabled)
                return;
            if (cutContext.Planes == null || cutContext.Planes.Count == 0)
                return;
            if (info.IndexCount < 3 || info.VertexCount < 3)
                return;

            // ~300 mm — host cut caps (walls/floors) often sit off GetSectionBox slightly.
            const double distTol = 1.0;

            var surface = new List<uint>(info.IndexCount);
            var cut = new List<uint>();

            int indexStart = info.FirstIndex;
            int indexEnd = info.FirstIndex + info.IndexCount;
            if (indexStart < 0 || indexEnd > result.Indices.Count)
                return;

            for (int i = indexStart; i + 2 < indexEnd; i += 3)
            {
                uint ia = result.Indices[i];
                uint ib = result.Indices[i + 1];
                uint ic = result.Indices[i + 2];

                if (TriangleOnCutPlane(result.Positions, ia, ib, ic, cutContext.Planes, distTol))
                {
                    cut.Add(ia);
                    cut.Add(ib);
                    cut.Add(ic);
                }
                else
                {
                    surface.Add(ia);
                    surface.Add(ib);
                    surface.Add(ic);
                }
            }

            if (cut.Count == 0)
                return;

            int write = indexStart;
            for (int i = 0; i < surface.Count; i++)
                result.Indices[write++] = surface[i];
            for (int i = 0; i < cut.Count; i++)
                result.Indices[write++] = cut[i];

            info.CutIndexCount = cut.Count;
            if (!info.CutColor.HasValue)
                info.CutColor = DefaultCutColorRgb;
            cutContext.FacesDeferred += cut.Count / 3;
        }

        private static bool TriangleOnCutPlane(
            List<float> positions,
            uint ia,
            uint ib,
            uint ic,
            List<(XYZ Normal, XYZ Origin)> planes,
            double distTol)
        {
            if (!TryGetVertex(positions, ia, out double ax, out double ay, out double az))
                return false;
            if (!TryGetVertex(positions, ib, out double bx, out double by, out double bz))
                return false;
            if (!TryGetVertex(positions, ic, out double cx, out double cy, out double cz))
                return false;

            foreach ((XYZ n, XYZ o) in planes)
            {
                double da = Math.Abs(n.X * (ax - o.X) + n.Y * (ay - o.Y) + n.Z * (az - o.Z));
                if (da > distTol) continue;
                double db = Math.Abs(n.X * (bx - o.X) + n.Y * (by - o.Y) + n.Z * (bz - o.Z));
                if (db > distTol) continue;
                double dc = Math.Abs(n.X * (cx - o.X) + n.Y * (cy - o.Y) + n.Z * (cz - o.Z));
                if (dc > distTol) continue;
                return true;
            }

            return false;
        }

        private static bool TryGetVertex(List<float> positions, uint index, out double x, out double y, out double z)
        {
            long baseIndex = (long)index * 3;
            if (baseIndex < 0 || baseIndex + 2 >= positions.Count)
            {
                x = y = z = 0;
                return false;
            }

            x = positions[(int)baseIndex];
            y = positions[(int)baseIndex + 1];
            z = positions[(int)baseIndex + 2];
            return true;
        }

        /// <summary>
        /// Categories where an AABB proxy destroys readability (toilet cubicles become solid
        /// blocks, furniture becomes crates). Prefer real solids capped by MaxFacesPerElement.
        /// </summary>
        private static bool PreferFullMesh(Element element)
        {
            string cat = element?.Category?.Name ?? string.Empty;
            if (cat.IndexOf("Plumbing Fixture", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Casework", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Furniture", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Specialty Equipment", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Speciality Equipment", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Door", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Window", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Parking", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            // MEP: AABB proxies at elbows look like gaps; keep real solids (higher face budget below).
            // Built-in category id — Category.Name is localized (管道 / 管件) and will not contain "Pipe".
            if (NeedsFineGeometry(element)) return true;
            // A bounding box fills window and shaft holes. Keep the cut solid.
            if (IsHostFabric(element)) return true;

            string familyHint = null;
            try
            {
                if (element is FamilyInstance fi)
                    familyHint = fi.Symbol?.Family?.Name ?? fi.Symbol?.Name;
            }
            catch (Exception) { familyHint = null; }

            if (!string.IsNullOrEmpty(familyHint)
                && (familyHint.IndexOf("Cubicle", StringComparison.OrdinalIgnoreCase) >= 0
                    || familyHint.IndexOf("Toilet", StringComparison.OrdinalIgnoreCase) >= 0
                    || familyHint.IndexOf("Partition", StringComparison.OrdinalIgnoreCase) >= 0
                    || familyHint.IndexOf("Stall", StringComparison.OrdinalIgnoreCase) >= 0))
                return true;

            return false;
        }

        private static bool ShouldSimplifyToProxy(Element element, GeometryElement geometry, out string reason)
        {
            reason = null;
            string familyHint = null;
            try
            {
                if (element is FamilyInstance fi)
                    familyHint = fi.Symbol?.Family?.Name ?? fi.Symbol?.Name;
            }
            catch (Exception) { familyHint = null; }

            if (!string.IsNullOrEmpty(familyHint))
            {
                if (familyHint.IndexOf("Rigged", StringComparison.OrdinalIgnoreCase) >= 0
                    || familyHint.IndexOf("Robot", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    reason = "family_hint:" + familyHint;
                    return true;
                }
            }

            // Cubicles / fixtures / railings: keep real solids. Face budget still applies later.
            if (PreferFullMesh(element) || IsRailingElement(element))
                return false;

            EstimateGeometryCost(geometry, 0, out int faces, out int instances);
            if (faces >= SimplifyFaceEstimateThreshold)
            {
                reason = $"faces~{faces}";
                return true;
            }

            if (instances >= SimplifyInstanceThreshold)
            {
                reason = $"instances={instances}";
                return true;
            }

            return false;
        }

        private static void EstimateGeometryCost(GeometryElement geometry, int depth, out int faces, out int instances)
        {
            faces = 0;
            instances = 0;
            if (geometry == null || depth > 4)
                return;

            foreach (GeometryObject obj in geometry)
            {
                if (obj is GeometryInstance instance)
                {
                    instances++;
                    try
                    {
                        EstimateGeometryCost(instance.GetSymbolGeometry(), depth + 1, out int childFaces, out int childInstances);
                        faces += childFaces;
                        instances += childInstances;
                    }
                    catch (Exception) { /* ignore */ }

                    if (faces >= SimplifyFaceEstimateThreshold || instances >= SimplifyInstanceThreshold)
                        return;
                    continue;
                }

                if (obj is Solid solid)
                {
                    try
                    {
                        if (solid.Volume > 0)
                            faces += solid.Faces?.Size ?? 0;
                    }
                    catch (Exception) { /* ignore */ }
                    if (faces >= SimplifyFaceEstimateThreshold)
                        return;
                }
            }
        }

        /// <summary>
        /// 12-triangle axis-aligned box in place of a high-poly family. Still pickable via ElementId.
        /// </summary>
        private static bool EmitBoundingBoxProxy(
            Element element,
            Transform transform,
            PanelMeshResult result,
            PanelMeshElementInfo marker)
        {
            BoundingBoxXYZ bbox = null;
            try { bbox = element.get_BoundingBox(null); }
            catch (Exception) { bbox = null; }

            if (bbox == null || bbox.Min == null || bbox.Max == null)
                return false;

            XYZ min = bbox.Min;
            XYZ max = bbox.Max;
            // Apply element bbox transform if present, then the emit transform.
            Transform boxXf = bbox.Transform ?? Transform.Identity;
            Transform combined = transform ?? Transform.Identity;
            if (boxXf != null && !boxXf.IsIdentity)
                combined = combined.Multiply(boxXf);

            int baseVertex = (int)result.TotalVertices;
            XYZ[] corners =
            {
                new XYZ(min.X, min.Y, min.Z),
                new XYZ(max.X, min.Y, min.Z),
                new XYZ(max.X, max.Y, min.Z),
                new XYZ(min.X, max.Y, min.Z),
                new XYZ(min.X, min.Y, max.Z),
                new XYZ(max.X, min.Y, max.Z),
                new XYZ(max.X, max.Y, max.Z),
                new XYZ(min.X, max.Y, max.Z),
            };

            foreach (XYZ p in corners)
            {
                XYZ w = combined.OfPoint(p);
                result.Positions.Add((float)w.X);
                result.Positions.Add((float)w.Y);
                result.Positions.Add((float)w.Z);
            }

            // 6 faces × 2 tris; indices relative to this element's first vertex.
            int[,] tris =
            {
                { 0, 1, 2 }, { 0, 2, 3 }, // bottom
                { 4, 6, 5 }, { 4, 7, 6 }, // top
                { 0, 4, 5 }, { 0, 5, 1 }, // y-
                { 1, 5, 6 }, { 1, 6, 2 }, // x+
                { 2, 6, 7 }, { 2, 7, 3 }, // y+
                { 3, 7, 4 }, { 3, 4, 0 }, // x-
            };

            for (int t = 0; t < tris.GetLength(0); t++)
            {
                result.Indices.Add((uint)(baseVertex + tris[t, 0]));
                result.Indices.Add((uint)(baseVertex + tris[t, 1]));
                result.Indices.Add((uint)(baseVertex + tris[t, 2]));
            }

            marker.VertexCount = 8;
            marker.IndexCount = 36;
            marker.FacesEmitted = 6;
            return true;
        }

        private static void EmitGeometryElement(
            GeometryElement geometry,
            Transform parent,
            int depth,
            PanelMeshResult result,
            PanelMeshElementInfo marker,
            CutContext cutContext,
            long elementBudgetOverride = -1)
        {
            if (depth > MaxDepth || geometry == null)
                return;

            foreach (GeometryObject obj in geometry)
            {
                if (result.TotalVertices >= MaxVerticesPerBatch)
                {
                    result.Truncated = true;
                    return;
                }

                if (obj is GeometryInstance instance)
                {
                    if (IsIlluminationVolume(obj, cutContext?.Doc))
                        continue;

                    // Railings / balusters: nested symbol+transform stamping often shifts uprights.
                    // Instance geometry is already in the owning document's space.
                    if (MarkerIsRailing(marker))
                    {
                        GeometryElement railingGeom = null;
                        try { railingGeom = instance.GetInstanceGeometry(); }
                        catch (Exception) { railingGeom = null; }
                        if (railingGeom != null)
                            EmitGeometryElement(railingGeom, parent ?? Transform.Identity, depth + 1, result, marker, cutContext, elementBudgetOverride);
                        continue;
                    }

                    Transform combined = instance.Transform;
                    if (parent != null && !parent.IsIdentity)
                        combined = parent.Multiply(combined);

                    // Repeated family symbols (each window on a facade) tessellate once.
                    // Section-box planes stay on the slow path so cut faces keep their material.
                    if ((cutContext == null || cutContext.Planes == null || cutContext.Planes.Count == 0)
                        && TryStampCachedSymbol(instance, combined, result, marker, elementBudgetOverride, cutContext?.Doc))
                        continue;

                    GeometryElement symbol = null;
                    try { symbol = instance.GetSymbolGeometry(); }
                    catch (Exception) { symbol = null; }

                    long beforeVerts = result.TotalVertices;
                    if (symbol != null)
                        EmitGeometryElement(symbol, combined, depth + 1, result, marker, cutContext, elementBudgetOverride);

                    if (result.TotalVertices == beforeVerts)
                    {
                        GeometryElement instanceGeom = null;
                        try { instanceGeom = instance.GetInstanceGeometry(); }
                        catch (Exception) { instanceGeom = null; }
                        if (instanceGeom != null)
                            EmitGeometryElement(instanceGeom, parent ?? Transform.Identity, depth + 1, result, marker, cutContext, elementBudgetOverride);
                    }
                    continue;
                }

                if (obj is Solid solid)
                {
                    if (solid.Volume <= 0)
                        continue;
                    if (IsIlluminationVolume(solid, cutContext?.Doc) || SolidIsLightBeam(solid, cutContext?.Doc, marker))
                        continue;
                    EmitSolid(solid, parent, result, marker, cutContext, elementBudgetOverride);
                    continue;
                }

                if (obj is Mesh mesh)
                {
                    if (IsIlluminationVolume(mesh, cutContext?.Doc) || MeshIsLightBeam(mesh, marker))
                        continue;
                    EmitMesh(mesh, parent, result, marker, elementBudgetOverride);
                }
            }
        }

        private static void EmitSolid(
            Solid solid,
            Transform parent,
            PanelMeshResult result,
            PanelMeshElementInfo marker,
            CutContext cutContext,
            long elementBudgetOverride)
        {
            // Link extracts share one marker; a per-element face cap would stop the whole link.
            bool aggregate = elementBudgetOverride >= 0;
            int faceCap = aggregate
                ? int.MaxValue
                : marker != null && marker.TessellationLod >= 0.9 ? 16000
                : marker != null && marker.HighDetail ? MaxFacesPerMepElement
                : marker != null && marker.KeepSolid ? 12000
                : MaxFacesPerElement;
            double lod = marker != null && marker.TessellationLod > 0
                ? marker.TessellationLod
                : marker != null && marker.HighDetail ? 0.5 : 0.0;
            foreach (Face face in solid.Faces)
            {
                if (marker.FacesEmitted >= faceCap)
                {
                    result.Truncated = true;
                    return;
                }

                if (result.TotalVertices >= MaxVerticesPerBatch)
                {
                    result.Truncated = true;
                    return;
                }

                Mesh mesh = null;
                try { mesh = face.Triangulate(lod); }
                catch (Exception) { /* skip this face */ }

                if (mesh == null)
                    continue;

                marker.FacesEmitted++;

                // Defer cut faces so they land at the end of this element's index range.
                if (cutContext != null && cutContext.Enabled && IsCutFace(cutContext, face, mesh, parent))
                {
                    cutContext.FacesDeferred++;
                    cutContext.DeferredCuts.Add((mesh, parent, ResolveCutColor(cutContext.Doc, face)));
                    continue;
                }

                EmitMesh(mesh, parent, result, marker, elementBudgetOverride);
            }
        }

        private static void FlushDeferredCuts(
            PanelMeshResult result,
            PanelMeshElementInfo marker,
            CutContext cutContext,
            long elementBudgetOverride)
        {
            if (cutContext == null || cutContext.DeferredCuts == null || cutContext.DeferredCuts.Count == 0)
                return;

            long cutStart = result.TotalIndices;
            foreach ((Mesh mesh, Transform xf, int? color) in cutContext.DeferredCuts)
            {
                if (color.HasValue && !marker.CutColor.HasValue)
                    marker.CutColor = color;
                EmitMesh(mesh, xf, result, marker, elementBudgetOverride);
            }

            marker.CutIndexCount += (int)(result.TotalIndices - cutStart);
            cutContext.DeferredCuts.Clear();
        }

        private static void EmitMesh(
            Mesh mesh,
            Transform parent,
            PanelMeshResult result,
            PanelMeshElementInfo marker,
            long elementBudgetOverride = -1)
        {
            if (mesh == null)
                return;

            int vertexCount;
            int triangleCount;
            try
            {
                vertexCount = mesh.Vertices == null ? 0 : mesh.Vertices.Count;
                triangleCount = mesh.NumTriangles;
            }
            catch (Exception)
            {
                return;
            }

            if (vertexCount == 0 || triangleCount == 0)
                return;

            // An explicit element budget (e.g. for link containers, whose marker aggregates
            // many child elements) overrides the per-leaf-element ceiling; the batch budget
            // always applies.
            long elementBudget = elementBudgetOverride >= 0
                ? elementBudgetOverride - marker.VertexCount
                : MaxVerticesPerElement - marker.VertexCount;
            long batchBudget = MaxVerticesPerBatch - result.TotalVertices;
            long budgetLong = Math.Min(elementBudget, batchBudget);
            if (budgetLong <= 0)
            {
                result.Truncated = true;
                return;
            }

            int budget = (int)Math.Min(budgetLong, int.MaxValue);
            bool truncated = false;
            if (vertexCount > budget)
            {
                truncated = true;
                vertexCount = budget;
                triangleCount = budget; // conservative cap; invalid indices are skipped below
            }

            int baseVertex = (int)result.TotalVertices;
            bool hasTransform = parent != null && !parent.IsIdentity;

            for (int i = 0; i < vertexCount; i++)
            {
                XYZ point;
                try
                {
                    point = mesh.Vertices[i];
                }
                catch (Exception)
                {
                    continue;
                }

                if (hasTransform)
                    point = parent.OfPoint(point);

                result.Positions.Add((float)point.X);
                result.Positions.Add((float)point.Y);
                result.Positions.Add((float)point.Z);
            }

            int emittedVertices = result.Positions.Count / 3 - baseVertex;
            if (emittedVertices <= 0)
                return;

            uint baseIndex = (uint)baseVertex;
            for (int i = 0; i < triangleCount; i++)
            {
                MeshTriangle triangle;
                try
                {
                    triangle = mesh.get_Triangle(i);
                }
                catch (Exception)
                {
                    continue;
                }

                int a = (int)triangle.get_Index(0);
                int b = (int)triangle.get_Index(1);
                int c = (int)triangle.get_Index(2);
                if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount)
                    continue;

                result.Indices.Add(baseIndex + (uint)a);
                result.Indices.Add(baseIndex + (uint)b);
                result.Indices.Add(baseIndex + (uint)c);
            }

            marker.VertexCount += emittedVertices;
            if (truncated)
                result.Truncated = true;
        }

        /// <summary>
        /// View-clip cut detection state for one extract pass.
        /// DeferredCuts are flushed once per panel element so cut indices stay contiguous at the end.
        /// </summary>
        private sealed class CutContext
        {
            public bool Enabled;
            public Document Doc;
            public View View;
            public List<(XYZ Normal, XYZ Origin)> Planes = new();
            public List<(Mesh Mesh, Transform Transform, int? Color)> DeferredCuts = new();
            /// <summary>Shared mutable counter so WithDocument clones still tally the same extract.</summary>
            public int[] FacesDeferredCounter { get; private set; } = new int[1];

            public int FacesDeferred
            {
                get => FacesDeferredCounter[0];
                set => FacesDeferredCounter[0] = value;
            }

            public CutContext WithDocument(Document doc)
            {
                return new CutContext
                {
                    Enabled = Enabled,
                    Doc = doc,
                    View = View,
                    Planes = Planes,
                    DeferredCuts = DeferredCuts,
                    FacesDeferredCounter = FacesDeferredCounter,
                };
            }

            public void BeginElement()
            {
                DeferredCuts?.Clear();
            }
        }

        private static CutContext BuildCutContext(Document doc, View view, bool sectionBoxActive)
        {
            var ctx = new CutContext
            {
                Doc = doc,
                View = view,
                Enabled = view != null,
            };

            if (!ctx.Enabled)
                return ctx;

            if (view is View3D view3d)
            {
                // Only scope/section-box planes for 3D — never the camera facing plane
                // (that would paint every front face as a cut).
                if (sectionBoxActive)
                {
                    try
                    {
                        BoundingBoxXYZ box = view3d.GetSectionBox();
                        if (box != null)
                            CollectSectionBoxPlanes(box, ctx.Planes);
                    }
                    catch (Exception) { /* keep GraphicsStyle-only detection */ }
                }
            }
            else if (view != null)
            {
                // Section / elevation / detail: one cut plane facing the view direction.
                try
                {
                    XYZ dir = view.ViewDirection;
                    XYZ origin = view.Origin;
                    if (dir != null && origin != null)
                        ctx.Planes.Add((dir.Normalize(), origin));
                }
                catch (Exception) { /* ignore */ }
            }

            return ctx;
        }

        private static void CollectSectionBoxPlanes(BoundingBoxXYZ box, List<(XYZ Normal, XYZ Origin)> planes)
        {
            if (box == null || planes == null)
                return;

            Transform t = box.Transform ?? Transform.Identity;
            XYZ min = box.Min;
            XYZ max = box.Max;
            if (min == null || max == null)
                return;

            XYZ x = t.OfVector(XYZ.BasisX);
            XYZ y = t.OfVector(XYZ.BasisY);
            XYZ z = t.OfVector(XYZ.BasisZ);
            if (x.GetLength() < 1e-9 || y.GetLength() < 1e-9 || z.GetLength() < 1e-9)
                return;

            x = x.Normalize();
            y = y.Normalize();
            z = z.Normalize();

            XYZ pMin = t.OfPoint(min);
            XYZ pMax = t.OfPoint(max);

            // Outward normals — Three.js clips the positive side, keeping the box interior.
            planes.Add((-x, pMin));
            planes.Add((x, pMax));
            planes.Add((-y, pMin));
            planes.Add((y, pMax));
            planes.Add((-z, pMin));
            planes.Add((z, pMax));
        }

        private static void CollectSectionBoxCorners(BoundingBoxXYZ box, List<float> corners)
        {
            if (box == null || corners == null)
                return;

            Transform t = box.Transform ?? Transform.Identity;
            XYZ min = box.Min;
            XYZ max = box.Max;
            if (min == null || max == null)
                return;

            XYZ[] local =
            {
                new XYZ(min.X, min.Y, min.Z),
                new XYZ(max.X, min.Y, min.Z),
                new XYZ(max.X, max.Y, min.Z),
                new XYZ(min.X, max.Y, min.Z),
                new XYZ(min.X, min.Y, max.Z),
                new XYZ(max.X, min.Y, max.Z),
                new XYZ(max.X, max.Y, max.Z),
                new XYZ(min.X, max.Y, max.Z),
            };

            foreach (XYZ p in local)
            {
                XYZ w = t.OfPoint(p);
                corners.Add((float)w.X);
                corners.Add((float)w.Y);
                corners.Add((float)w.Z);
            }
        }

        private static bool IsCutFace(CutContext cutContext, Face face, Mesh mesh, Transform toHost)
        {
            if (cutContext == null || !cutContext.Enabled || face == null)
                return false;

            // Section views often tag cut edges; 3D scope boxes often do not.
            if (HasCutGraphicsStyle(cutContext.Doc, face))
                return true;

            // Reliable for scope/section box: triangulated vertices sit on the clip plane.
            return MeshLiesOnSectionPlane(cutContext, mesh, toHost);
        }

        private static bool HasCutGraphicsStyle(Document doc, Face face)
        {
            if (doc == null || face == null)
                return false;

            try
            {
                EdgeArrayArray loops = face.EdgeLoops;
                if (loops == null || loops.Size == 0)
                    return false;

                // Any edge with Cut style is enough — first edge alone was too brittle.
                for (int loopIndex = 0; loopIndex < loops.Size; loopIndex++)
                {
                    EdgeArray edges = loops.get_Item(loopIndex);
                    if (edges == null)
                        continue;

                    for (int edgeIndex = 0; edgeIndex < edges.Size; edgeIndex++)
                    {
                        Edge edge = edges.get_Item(edgeIndex);
                        if (edge == null || edge.GraphicsStyleId == ElementId.InvalidElementId)
                            continue;

                        if (!(doc.GetElement(edge.GraphicsStyleId) is GraphicsStyle style))
                            continue;

                        if (style.GraphicsStyleType == GraphicsStyleType.Cut)
                            return true;
                    }
                }
            }
            catch (Exception)
            {
                return false;
            }

            return false;
        }

        private static bool MeshLiesOnSectionPlane(CutContext cutContext, Mesh mesh, Transform toHost)
        {
            if (mesh == null || cutContext.Planes == null || cutContext.Planes.Count == 0)
                return false;

            IList<XYZ> vertices;
            int triangleCount;
            try
            {
                vertices = mesh.Vertices;
                triangleCount = mesh.NumTriangles;
            }
            catch (Exception)
            {
                return false;
            }

            if (vertices == null || vertices.Count < 3 || triangleCount <= 0)
                return false;

            bool hasTransform = toHost != null && !toHost.IsIdentity;

            XYZ meshNormal;
            try
            {
                MeshTriangle tri = mesh.get_Triangle(0);
                XYZ a = vertices[(int)tri.get_Index(0)];
                XYZ b = vertices[(int)tri.get_Index(1)];
                XYZ c = vertices[(int)tri.get_Index(2)];
                if (hasTransform)
                {
                    a = toHost.OfPoint(a);
                    b = toHost.OfPoint(b);
                    c = toHost.OfPoint(c);
                }

                meshNormal = (b - a).CrossProduct(c - a);
                if (meshNormal.GetLength() < 1e-12)
                    return false;
                meshNormal = meshNormal.Normalize();
            }
            catch (Exception)
            {
                return false;
            }

            // ~5° normal alignment; ~25 mm plane distance — scope-box caps are exact in theory
            // but instance transforms + coarse triangulation introduce slack.
            const double normalTol = 0.08;
            const double distTol = 0.08;

            int sampleCount = Math.Min(vertices.Count, 16);

            foreach ((XYZ planeNormal, XYZ planeOrigin) in cutContext.Planes)
            {
                if (!meshNormal.IsAlmostEqualTo(planeNormal, normalTol)
                    && !meshNormal.IsAlmostEqualTo(planeNormal.Negate(), normalTol))
                    continue;

                bool allOnPlane = true;
                for (int i = 0; i < sampleCount; i++)
                {
                    XYZ p = vertices[i];
                    if (hasTransform)
                        p = toHost.OfPoint(p);

                    if (Math.Abs(planeNormal.DotProduct(p - planeOrigin)) > distTol)
                    {
                        allOnPlane = false;
                        break;
                    }
                }

                if (allOnPlane)
                    return true;
            }

            return false;
        }

        private static bool IsOpeningElement(Element element)
        {
            if (element == null) return false;
            if (element is Opening) return true;
            if (BicOf(element) == BuiltInCategory.OST_ShaftOpening) return true;
            string cat = element.Category?.Name ?? string.Empty;
            if (cat.IndexOf("洞口", StringComparison.Ordinal) >= 0) return true;
            if (cat.IndexOf("Shaft Opening", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        /// <summary>Hosts whose voids must stay visible: walls, floors, roofs, windows, curtain panels.</summary>
        private static bool IsHostFabric(Element element)
        {
            switch (BicOf(element))
            {
                case BuiltInCategory.OST_Walls:
                case BuiltInCategory.OST_Floors:
                case BuiltInCategory.OST_Roofs:
                case BuiltInCategory.OST_Ceilings:
                case BuiltInCategory.OST_Windows:
                case BuiltInCategory.OST_CurtainWallPanels:
                case BuiltInCategory.OST_CurtainWallMullions:
                case BuiltInCategory.OST_Doors:
                    return true;
            }
            return false;
        }

        private static bool NameIsLightVolume(string name)
        {
            if (string.IsNullOrEmpty(name))
                return false;
            if (name.IndexOf("Light Source", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("光源", StringComparison.Ordinal) >= 0) return true;
            if (name.IndexOf("照亮", StringComparison.Ordinal) >= 0) return true;
            if (name.IndexOf("光锥", StringComparison.Ordinal) >= 0) return true;
            if (name.IndexOf("光域", StringComparison.Ordinal) >= 0) return true;
            if (name.IndexOf("配光", StringComparison.Ordinal) >= 0) return true;
            if (name.IndexOf("Illumination", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("Photometric", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("Light Beam", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private static bool IsIlluminationVolume(GeometryObject obj, Document doc)
        {
            if (obj == null || doc == null)
                return false;
            try
            {
                ElementId id = obj.GraphicsStyleId;
                if (id == null || id == ElementId.InvalidElementId)
                    return false;
                if (!(doc.GetElement(id) is GraphicsStyle style))
                    return false;
                return NameIsLightVolume(style.GraphicsStyleCategory?.Name);
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Spot beams are photometric volumes. Art-glass pendant shades are often conical too —
        /// keep anything with a glass material, and only drop large unnamed light cones.
        /// </summary>
        private static bool SolidIsLightBeam(Solid solid, Document doc, PanelMeshElementInfo marker)
        {
            if (solid == null || marker == null || marker.TessellationLod < 0.9)
                return false;
            try
            {
                bool conical = false;
                bool namedVolume = false;
                bool glassFace = false;
                int triangles = 0;
                int apexHits = 0;
                var vertexHits = new Dictionary<long, int>();
                foreach (Face face in solid.Faces)
                {
                    if (face is ConicalFace)
                        conical = true;
                    if (IsIlluminationVolume(face, doc))
                        namedVolume = true;
                    if (doc != null && doc.GetElement(face.MaterialElementId) is Material material)
                    {
                        if (NameIsLightVolume(material.Name))
                            namedVolume = true;
                        if (MaterialIsGlass(material))
                            glassFace = true;
                    }

                    if (triangles > 800)
                        continue;
                    Mesh mesh = null;
                    try { mesh = face.Triangulate(0); }
                    catch (Exception) { mesh = null; }
                    if (mesh == null)
                        continue;
                    for (int i = 0; i < mesh.NumTriangles && triangles <= 800; i++)
                    {
                        triangles++;
                        MeshTriangle tri = mesh.get_Triangle(i);
                        for (int k = 0; k < 3; k++)
                        {
                            long key = QuantizePoint(tri.get_Vertex(k));
                            int hits = vertexHits.TryGetValue(key, out int have) ? have + 1 : 1;
                            vertexHits[key] = hits;
                            if (hits > apexHits)
                                apexHits = hits;
                        }
                    }
                }

                // Glass / art-glass shades stay, even when the shade is a cone.
                if (glassFace)
                    return false;
                if (namedVolume)
                    return true;

                // Unnamed photometric cones are room-scale. Pendant shades are typically under ~4 ft.
                double span = LongestFeet(solid);
                if (span < 4.0)
                    return false;
                if (conical)
                    return true;
                return triangles >= 8 && apexHits >= triangles * 0.5;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool MeshIsLightBeam(Mesh mesh, PanelMeshElementInfo marker)
        {
            if (mesh == null || marker == null || marker.TessellationLod < 0.9)
                return false;
            try
            {
                int triangles = mesh.NumTriangles;
                if (triangles < 8 || triangles > 800)
                    return false;
                double maxSpan = 0;
                try
                {
                    XYZ min = mesh.Vertices[0];
                    XYZ max = min;
                    for (int v = 1; v < mesh.Vertices.Count; v++)
                    {
                        XYZ p = mesh.Vertices[v];
                        min = new XYZ(Math.Min(min.X, p.X), Math.Min(min.Y, p.Y), Math.Min(min.Z, p.Z));
                        max = new XYZ(Math.Max(max.X, p.X), Math.Max(max.Y, p.Y), Math.Max(max.Z, p.Z));
                    }
                    XYZ size = max - min;
                    maxSpan = Math.Max(size.X, Math.Max(size.Y, size.Z));
                }
                catch (Exception) { maxSpan = 0; }
                // Without a material name, only drop room-scale fans — not a pendant shade.
                if (maxSpan < 4.0)
                    return false;
                int apexHits = 0;
                var vertexHits = new Dictionary<long, int>();
                for (int i = 0; i < triangles; i++)
                {
                    MeshTriangle tri = mesh.get_Triangle(i);
                    for (int k = 0; k < 3; k++)
                    {
                        long key = QuantizePoint(tri.get_Vertex(k));
                        int hits = vertexHits.TryGetValue(key, out int have) ? have + 1 : 1;
                        vertexHits[key] = hits;
                        if (hits > apexHits)
                            apexHits = hits;
                    }
                }

                return apexHits >= triangles * 0.5;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static double LongestFeet(Solid solid)
        {
            try
            {
                BoundingBoxXYZ box = solid.GetBoundingBox();
                if (box == null)
                    return 0;
                XYZ size = box.Max - box.Min;
                return Math.Max(size.X, Math.Max(size.Y, size.Z));
            }
            catch (Exception)
            {
                return 0;
            }
        }

        private static long QuantizePoint(XYZ point)
        {
            long x = (long)Math.Round(point.X * 64.0);
            long y = (long)Math.Round(point.Y * 64.0);
            long z = (long)Math.Round(point.Z * 64.0);
            return (x << 42) ^ (y << 21) ^ (z & 0x1FFFFF);
        }

        private static bool IsLighting(Element element)
        {
            switch (BicOf(element))
            {
                case BuiltInCategory.OST_LightingFixtures:
                case BuiltInCategory.OST_LightingDevices:
                    return true;
            }

            string cat = element?.Category?.Name ?? string.Empty;
            if (cat.IndexOf("Lighting Fixture", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("灯具", StringComparison.Ordinal) >= 0) return true;
            return false;
        }

        private static bool MarkerIsRailing(PanelMeshElementInfo marker)
        {
            if (marker == null)
                return false;
            return CategoryNameIsRailing(marker.Category);
        }

        private static bool IsRailingElement(Element element)
        {
            if (element == null)
                return false;
            switch (BicOf(element))
            {
                case BuiltInCategory.OST_StairsRailing:
                case BuiltInCategory.OST_RailingHandRail:
                case BuiltInCategory.OST_RailingTopRail:
                case BuiltInCategory.OST_RailingSupport:
                case BuiltInCategory.OST_RailingTermination:
                    return true;
            }

            return CategoryNameIsRailing(element.Category?.Name);
        }

        private static bool CategoryNameIsRailing(string category)
        {
            if (string.IsNullOrEmpty(category))
                return false;
            if (category.IndexOf("Railing", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (category.IndexOf("Handrail", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (category.IndexOf("Top Rail", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (category.IndexOf("Baluster", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (string.Equals(category, "Supports", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(category, "Terminations", StringComparison.OrdinalIgnoreCase)) return true;
            if (category.IndexOf("栏杆", StringComparison.Ordinal) >= 0) return true;
            if (category.IndexOf("扶手", StringComparison.Ordinal) >= 0) return true;
            return false;
        }

        /// <summary>Art-glass pendants and glazed shades carry a glass material on the instance or type.</summary>
        private static bool ElementHasGlassMaterial(Element element)
        {
            if (element?.Document == null)
                return false;
            try
            {
                foreach (ElementId id in element.GetMaterialIds(false))
                {
                    if (element.Document.GetElement(id) is Material material && MaterialIsGlass(material))
                        return true;
                }
            }
            catch (Exception) { /* type materials below */ }

            try
            {
                ElementId typeId = element.GetTypeId();
                if (typeId != null && typeId != ElementId.InvalidElementId
                    && element.Document.GetElement(typeId) is Element type)
                {
                    foreach (ElementId id in type.GetMaterialIds(false))
                    {
                        if (element.Document.GetElement(id) is Material material && MaterialIsGlass(material))
                            return true;
                    }
                }
            }
            catch (Exception) { /* name only */ }

            string hint = element.Name ?? string.Empty;
            try
            {
                if (element is FamilyInstance fi)
                    hint = (fi.Symbol?.Family?.Name ?? string.Empty) + " " + (fi.Symbol?.Name ?? string.Empty) + " " + hint;
            }
            catch (Exception) { /* name only */ }

            if (hint.IndexOf("glass", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (hint.IndexOf("glaz", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (hint.IndexOf("玻璃", StringComparison.Ordinal) >= 0) return true;
            return false;
        }

        private static void FillIdentity(PanelMeshElementInfo info, Element element, string modelName)
        {
            if (info == null)
                return;
            info.ModelName = modelName ?? string.Empty;
            if (!(element is FamilyInstance fi))
            {
                info.TypeName = element?.Name ?? string.Empty;
                return;
            }

            try
            {
                info.FamilyName = fi.Symbol?.Family?.Name ?? string.Empty;
                info.TypeName = fi.Symbol?.Name ?? fi.Name ?? string.Empty;
            }
            catch (Exception)
            {
                info.TypeName = element.Name ?? string.Empty;
            }
        }

        /// <summary>
        /// Fine solids, not Medium. Medium drops the swept P-trap inside families such as Sink Connection Vanity.
        /// </summary>
        private static bool NeedsFineGeometry(Element element)
        {
            if (IsMepElement(element)) return true;
            if (BicOf(element) == BuiltInCategory.OST_PlumbingFixtures) return true;
            if (IsLighting(element)) return true;

            string hint = element?.Name ?? string.Empty;
            try
            {
                if (element is FamilyInstance fi)
                    hint = (fi.Symbol?.Family?.Name ?? string.Empty) + " " + (fi.Symbol?.Name ?? string.Empty) + " " + hint;
            }
            catch (Exception) { /* name only */ }

            if (hint.IndexOf("Sink Connection", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (hint.IndexOf("P-Trap", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (hint.IndexOf("Ptrap", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (hint.IndexOf("Vanity", StringComparison.OrdinalIgnoreCase) >= 0
                && hint.IndexOf("Sink", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private static bool IsMepElement(Element element)
        {
            if (element == null) return false;
            if (element is MEPCurve) return true;
            try
            {
                Category category = element.Category;
                if (category == null) return IsMepCategoryName(null);
                long cid = PanelElementIds.GetValue(category.Id);
                switch ((BuiltInCategory)cid)
                {
                    case BuiltInCategory.OST_PipeCurves:
                    case BuiltInCategory.OST_PipeFitting:
                    case BuiltInCategory.OST_PlumbingFixtures:
                    case BuiltInCategory.OST_PipeAccessory:
                    case BuiltInCategory.OST_FlexPipeCurves:
                    case BuiltInCategory.OST_PipeInsulations:
                    case BuiltInCategory.OST_PlaceHolderPipes:
                    case BuiltInCategory.OST_DuctCurves:
                    case BuiltInCategory.OST_DuctFitting:
                    case BuiltInCategory.OST_DuctAccessory:
                    case BuiltInCategory.OST_FlexDuctCurves:
                    case BuiltInCategory.OST_DuctInsulations:
                    case BuiltInCategory.OST_PlaceHolderDucts:
                    case BuiltInCategory.OST_CableTray:
                    case BuiltInCategory.OST_CableTrayFitting:
                    case BuiltInCategory.OST_Conduit:
                    case BuiltInCategory.OST_ConduitFitting:
                    case BuiltInCategory.OST_Sprinklers:
                        return true;
                }
            }
            catch (Exception) { /* fall through to name */ }

            return IsMepCategoryName(element.Category?.Name);
        }

        private static bool IsMepCategoryName(string cat)
        {
            if (string.IsNullOrEmpty(cat)) return false;
            if (cat.IndexOf("Pipe", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Duct", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Cable Tray", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Conduit", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Flex Pipe", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Flex Duct", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("Sprinkler", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private static bool IsUsableColor(Color color)
        {
            if (color == null) return false;
            try
            {
                if (!color.IsValid) return false;
            }
            catch (Exception) { /* older hosts */ }

            // (0,0,0) usually means "no override" for system / graphic settings.
            if (color.Red == 0 && color.Green == 0 && color.Blue == 0) return false;
            return true;
        }

        private static int ToRgb(Color color) => (color.Red << 16) | (color.Green << 8) | color.Blue;

        /// <summary>
        /// Surface colour for Canvas: view overrides first, then MEP system type Fill/Line color.
        /// </summary>
        private static int? ResolveDisplayColor(Document doc, View view, Element element)
        {
            if (element == null) return null;

            if (view != null)
            {
                try
                {
                    OverrideGraphicSettings ogs = view.GetElementOverrides(element.Id);
                    try
                    {
                        Color surface = ogs.SurfaceForegroundPatternColor;
                        if (IsUsableColor(surface)) return ToRgb(surface);
                    }
                    catch (Exception) { /* API may differ by year */ }
                    Color line = ogs.ProjectionLineColor;
                    if (IsUsableColor(line)) return ToRgb(line);
                }
                catch (Exception) { /* ignore */ }
            }

            int? system = ResolveMepSystemColor(doc ?? element.Document, element);
            if (system.HasValue) return system;

            return null;
        }

        private static int? ResolveMepSystemColor(Document doc, Element element)
        {
            if (doc == null || element == null) return null;

            try
            {
                if (element is MEPCurve curve && curve.MEPSystem != null)
                {
                    int? fromCurve = ColorFromSystem(doc, curve.MEPSystem);
                    if (fromCurve.HasValue) return fromCurve;
                }
            }
            catch (Exception) { /* ignore */ }

            try
            {
                if (element is FamilyInstance fi
                    && fi.MEPModel?.ConnectorManager?.Connectors != null)
                {
                    foreach (Connector connector in fi.MEPModel.ConnectorManager.Connectors)
                    {
                        try
                        {
                            if (connector?.MEPSystem == null) continue;
                            int? fromConn = ColorFromSystem(doc, connector.MEPSystem);
                            if (fromConn.HasValue) return fromConn;
                        }
                        catch (Exception) { /* next connector */ }
                    }
                }
            }
            catch (Exception) { /* ignore */ }

            foreach (BuiltInParameter bip in new[]
                     {
                         BuiltInParameter.RBS_PIPING_SYSTEM_TYPE_PARAM,
                         BuiltInParameter.RBS_DUCT_SYSTEM_TYPE_PARAM,
                     })
            {
                try
                {
                    Parameter p = element.get_Parameter(bip);
                    ElementId typeId = p?.AsElementId() ?? ElementId.InvalidElementId;
                    if (typeId == ElementId.InvalidElementId) continue;
                    if (doc.GetElement(typeId) is MEPSystemType systemType)
                    {
                        int? rgb = ColorFromSystemType(systemType);
                        if (rgb.HasValue) return rgb;
                    }
                }
                catch (Exception) { /* next */ }
            }

            return null;
        }

        private static int? ColorFromSystem(Document doc, MEPSystem system)
        {
            if (system == null || doc == null) return null;
            try
            {
                if (doc.GetElement(system.GetTypeId()) is MEPSystemType systemType)
                    return ColorFromSystemType(systemType);
            }
            catch (Exception) { /* ignore */ }
            return null;
        }

        private static int? ColorFromSystemType(MEPSystemType systemType)
        {
            if (systemType == null) return null;
            try
            {
                Color fill = systemType.FillColor;
                if (IsUsableColor(fill)) return ToRgb(fill);
            }
            catch (Exception) { /* ignore */ }
            try
            {
                Color line = systemType.LineColor;
                if (IsUsableColor(line)) return ToRgb(line);
            }
            catch (Exception) { /* ignore */ }
            return null;
        }

        /// <summary>
        /// Default architectural cut fill — dark slate like Revit coarse cut, never white.
        /// Prefer the face material's cut/foreground color when it is not near-white.
        /// </summary>
        private const int DefaultCutColorRgb = 0x3a3a42;

        private static int? ResolveCutColor(Document doc, Face face)
        {
            if (doc == null || face == null)
                return DefaultCutColorRgb;

            try
            {
                if (face.MaterialElementId == ElementId.InvalidElementId)
                    return DefaultCutColorRgb;

                if (!(doc.GetElement(face.MaterialElementId) is Material material))
                    return DefaultCutColorRgb;

                bool hasColor = false;
                Color color = new Color(0, 0, 0);
                try
                {
                    color = material.CutForegroundPatternColor;
                    hasColor = true;
                }
                catch (Exception) { hasColor = false; }

                if (!hasColor || (color.Red == 0 && color.Green == 0 && color.Blue == 0))
                {
                    try
                    {
                        color = material.Color;
                        hasColor = true;
                    }
                    catch (Exception) { hasColor = false; }
                }

                if (!hasColor)
                    return DefaultCutColorRgb;

                // Near-white cut fills read as "broken white model" — force slate instead.
                if (color.Red >= 230 && color.Green >= 230 && color.Blue >= 230)
                    return DefaultCutColorRgb;

                return (color.Red << 16) | (color.Green << 8) | color.Blue;
            }
            catch (Exception)
            {
                return DefaultCutColorRgb;
            }
        }

        static readonly Dictionary<string, CachedSymbolMesh> SymbolMeshes = new Dictionary<string, CachedSymbolMesh>();
        static int SymbolCacheHits;
        static int SymbolCacheMisses;

        sealed class CachedSymbolMesh
        {
            public float[] Positions;
            public int[] Indices;
        }

        /// <summary>
        /// Tessellate a family symbol once in local space, then stamp later instances with their transform.
        /// Same triangles as extracting each instance. Returns false when the symbol has no solid so the caller
        /// can fall back to instance geometry (P-traps).
        /// </summary>
        static bool TryStampCachedSymbol(
            GeometryInstance instance,
            Transform combined,
            PanelMeshResult result,
            PanelMeshElementInfo marker,
            long elementBudgetOverride,
            Document doc)
        {
            if (instance == null || result == null || marker == null)
                return false;

            SymbolGeometryId symbolId = null;
            GeometryElement symbolGeom = null;
            try
            {
                symbolId = instance.GetSymbolGeometryId();
                symbolGeom = instance.GetSymbolGeometry();
            }
            catch (Exception)
            {
                return false;
            }

            if (symbolId?.SymbolId == null || symbolId.SymbolId == ElementId.InvalidElementId || symbolGeom == null)
                return false;

            long symbolKey = PanelElementIds.GetValue(symbolId.SymbolId);
            int shape = SymbolShapeSignature(symbolGeom);
            int lod = marker.HighDetail ? 500 : 0;
            string key = symbolKey + ":" + lod + ":" + shape;

            if (!SymbolMeshes.TryGetValue(key, out CachedSymbolMesh cached))
            {
                var scratch = new PanelMeshResult();
                var scratchInfo = new PanelMeshElementInfo
                {
                    HighDetail = marker.HighDetail,
                    KeepSolid = marker.KeepSolid,
                    TessellationLod = marker.TessellationLod,
                };
                // Doc only — planes are in model space and must not clip the symbol's local mesh.
                CutContext styleOnly = doc == null ? null : new CutContext { Doc = doc };
                EmitGeometryElement(symbolGeom, Transform.Identity, 0, scratch, scratchInfo, styleOnly, -1);
                if (scratch.TotalVertices <= 0 || scratch.TotalIndices <= 0)
                    return false;

                cached = new CachedSymbolMesh
                {
                    Positions = scratch.Positions.ToArray(),
                    Indices = scratch.Indices.Select(i => (int)i).ToArray(),
                };
                SymbolMeshes[key] = cached;
                SymbolCacheMisses++;
            }
            else
            {
                SymbolCacheHits++;
            }

            return StampCachedSymbol(cached, combined, result, marker, elementBudgetOverride);
        }

        static int SymbolShapeSignature(GeometryElement geometry)
        {
            int hash = 17;
            void Walk(GeometryElement g, int depth)
            {
                if (g == null || depth > 4)
                    return;
                foreach (GeometryObject obj in g)
                {
                    if (obj is GeometryInstance nested)
                    {
                        long id = 0;
                        try
                        {
                            SymbolGeometryId nestedId = nested.GetSymbolGeometryId();
                            if (nestedId?.SymbolId != null && nestedId.SymbolId != ElementId.InvalidElementId)
                                id = PanelElementIds.GetValue(nestedId.SymbolId);
                        }
                        catch (Exception) { id = 0; }
                        hash = unchecked(hash * 31 + (int)id);
                        try { Walk(nested.GetSymbolGeometry(), depth + 1); }
                        catch (Exception) { /* ignore */ }
                        continue;
                    }

                    if (obj is Solid solid)
                    {
                        try
                        {
                            if (solid.Volume <= 0)
                                continue;
                            hash = unchecked(hash * 31 + (solid.Faces?.Size ?? 0));
                            hash = unchecked(hash * 31 + (int)Math.Round(solid.Volume * 1000.0));
                        }
                        catch (Exception) { /* ignore */ }
                    }
                }
            }

            Walk(geometry, 0);
            return hash;
        }

        static bool StampCachedSymbol(
            CachedSymbolMesh cached,
            Transform combined,
            PanelMeshResult result,
            PanelMeshElementInfo marker,
            long elementBudgetOverride)
        {
            int vertCount = cached.Positions.Length / 3;
            if (vertCount <= 0)
                return false;

            long elementBudget = elementBudgetOverride >= 0
                ? elementBudgetOverride - marker.VertexCount
                : MaxVerticesPerElement - marker.VertexCount;
            long batchBudget = MaxVerticesPerBatch - result.TotalVertices;
            if (elementBudget < vertCount || batchBudget < vertCount)
            {
                result.Truncated = true;
                return true;
            }

            int baseVertex = (int)result.TotalVertices;
            bool hasTransform = combined != null && !combined.IsIdentity;
            for (int i = 0; i < vertCount; i++)
            {
                var point = new XYZ(cached.Positions[i * 3], cached.Positions[i * 3 + 1], cached.Positions[i * 3 + 2]);
                if (hasTransform)
                    point = combined.OfPoint(point);
                result.Positions.Add((float)point.X);
                result.Positions.Add((float)point.Y);
                result.Positions.Add((float)point.Z);
            }

            uint baseIndex = (uint)baseVertex;
            for (int i = 0; i + 2 < cached.Indices.Length; i += 3)
            {
                int a = cached.Indices[i];
                int b = cached.Indices[i + 1];
                int c = cached.Indices[i + 2];
                if (a < 0 || b < 0 || c < 0 || a >= vertCount || b >= vertCount || c >= vertCount)
                    continue;
                result.Indices.Add(baseIndex + (uint)a);
                result.Indices.Add(baseIndex + (uint)b);
                result.Indices.Add(baseIndex + (uint)c);
            }

            marker.VertexCount += vertCount;
            marker.FacesEmitted += cached.Indices.Length / 3;
            return true;
        }
    }
}
