using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

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
        public const int MaxVerticesPerElement = 100_000; // was 10_000 — large elements (curtain walls, big floors) were being truncated and flagging Truncated
        // Raised for all-model + linked models; user confirmed panel performance handles this easily.
        public const int MaxVerticesPerBatch = 5_000_000;
        // A link model aggregates many child elements behind one host element id.
        // Keep this at the same order as MaxVerticesPerElement: the 2M budget made
        // large links (e.g. Snowdon id=2448217) triangulate past the MCP 60s timeout.
        // Morning's fast full-model loads finished with truncated:true under ~100k/link.
        public const int MaxVerticesPerLink = 100_000;
        private const int MaxDepth = 8;
        /// <summary>Default hard stop so a single bad element cannot freeze the Revit UI forever.</summary>
        public const int DefaultMaxElapsedMs = 45_000;

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
        }

        /// <summary>
        /// Cap faces triangulated per element after we decide to keep full solids.
        /// </summary>
        public const int MaxFacesPerElement = 120;
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
            string name = element.Name ?? string.Empty;
            if (cat.IndexOf("window", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("curtain", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("glass", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cat.IndexOf("glaz", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("glass", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("glaz", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
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

                output.Add(candidate);
            }
        }

        public static PanelMeshResult Extract(Document doc, IList<Element> elements, ExtractOptions extractOptions = null)
        {
            extractOptions ??= new ExtractOptions();
            int maxElapsedMs = extractOptions.MaxElapsedMs > 0
                ? extractOptions.MaxElapsedMs
                : DefaultMaxElapsedMs;

            var result = new PanelMeshResult();
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var options = new Options
            {
                DetailLevel = ViewDetailLevel.Coarse,
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

            // When a 3D section/scope box is active, do NOT use Options.View for clipping —
            // Revit's view-specific solids miss caps and often disagree with the box.
            // Extract full solids; the panel clips with GetSectionBox planes (no box drawn).
            if (view != null && !sectionBoxActive)
            {
                try { options.View = view; }
                catch (Exception) { /* keep view-independent options */ }
            }

            CutContext cutContext = BuildCutContext(doc, view, sectionBoxActive);
            result.ClientSectionClip = sectionBoxActive && cutContext.Planes.Count >= 6;

            PanelService.Instance.WritePanelLog(
                $"Extract start count={elements?.Count ?? 0} skipLinks={extractOptions.SkipLinks} maxMs={maxElapsedMs} view={view?.Name ?? "(none)"} sectionBox={sectionBoxActive} clientClip={result.ClientSectionClip} cutPlanes={cutContext.Planes?.Count ?? 0}");

            int index = 0;
            foreach (Element element in elements)
            {
                index++;
                if (element == null)
                {
                    result.SkippedElements++;
                    continue;
                }

                if (sw.ElapsedMilliseconds > maxElapsedMs)
                {
                    result.Truncated = true;
                    result.SkippedElements += Math.Max(0, (elements?.Count ?? index) - index + 1);
                    PanelService.Instance.WritePanelLog(
                        $"Extract time-budget hit at {index}/{elements.Count} elapsedMs={sw.ElapsedMilliseconds}");
                    break;
                }

                if (result.TotalVertices >= MaxVerticesPerBatch)
                {
                    result.Truncated = true;
                    result.SkippedElements++;
                    continue;
                }

                if (index == 1 || index % 200 == 0)
                    PanelService.Instance.WritePanelLog($"Extract progress {index}/{elements.Count} elements={result.Elements.Count} verts={result.TotalVertices} elapsedMs={sw.ElapsedMilliseconds}");

                // A RevitLinkInstance is a container: its own geometry is empty but the linked
                // document holds the real model. Extract that nested model as one panel element,
                // so it is pickable/deletable as a single unit and moved by the link's transform.
                if (element is RevitLinkInstance linkInstance)
                {
                    if (extractOptions.SkipLinks)
                    {
                        result.SkippedElements++;
                        continue;
                    }

                    long t0 = sw.ElapsedMilliseconds;
                    PanelService.Instance.WritePanelLog("Extract link start id=" + PanelElementIds.GetValue(linkInstance.Id));
                    ExtractLinkInstance(doc, linkInstance, options, result, cutContext);
                    PanelService.Instance.WritePanelLog($"Extract link done id={PanelElementIds.GetValue(linkInstance.Id)} verts={result.TotalVertices} linkMs={sw.ElapsedMilliseconds - t0} elapsedMs={sw.ElapsedMilliseconds}");
                    continue;
                }

                long elementId = 0;
                try { elementId = PanelElementIds.GetValue(element.Id); } catch { elementId = 0; }
                long before = sw.ElapsedMilliseconds;
                EmitElement(element, elementId, element.Category?.Name, element.Name,
                    Transform.Identity, options, result, cutContext);
                long took = sw.ElapsedMilliseconds - before;
                if (took > 2000)
                {
                    PanelService.Instance.WritePanelLog(
                        $"Extract slow element id={elementId} cat={element.Category?.Name} ms={took}");
                }
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

            // Publish clip planes + corners so the panel can clip exactly to the section box.
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
                $"Extract done elements={result.Elements.Count} skipped={result.SkippedElements} verts={result.TotalVertices} elapsedMs={sw.ElapsedMilliseconds} truncated={result.Truncated} cutElements={cutElements} cutIndices={cutIndices} cutFacesSeen={cutContext.FacesDeferred}");
            return result;
        }

        /// <summary>
        /// Recursively expands a linked model, treating each nested link inside a link as a
        /// sub-container (depth-limited so pathological chains cannot blow the stack).
        /// Every emitted mesh carries the host link instance's element id.
        /// </summary>
        private static void ExtractLinkInstance(
            Document hostDocument,
            RevitLinkInstance linkInstance,
            Options options,
            PanelMeshResult result,
            CutContext cutContext,
            Transform parentTransform = null,
            int depth = 0)
        {
            const int MaxLinkDepth = 3;
            if (linkInstance == null || depth > MaxLinkDepth)
                return;

            Document linkedDoc = null;
            try { linkedDoc = linkInstance.GetLinkDocument(); }
            catch (Exception) { linkedDoc = null; }

            if (linkedDoc == null)
            {
                // Link not loaded — nothing to draw.
                result.SkippedElements++;
                return;
            }

            Transform linkTransform = Transform.Identity;
            try { linkTransform = linkInstance.GetTotalTransform(); }
            catch (Exception) { try { linkTransform = linkInstance.GetTransform(); } catch { } }

            if (parentTransform != null && !parentTransform.IsIdentity)
                linkTransform = parentTransform.Multiply(linkTransform);

            long hostElementId = PanelElementIds.GetValue(linkInstance.Id);
            string linkName = linkInstance.Name ?? string.Empty;
            string linkCategoryName = linkInstance.Category?.Name ?? "Revit Link";

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

                nestedElements.Add(candidate);
            }

            foreach (RevitLinkInstance nested in nestedLinks)
            {
                ExtractLinkInstance(hostDocument, nested, options, result, cutContext, linkTransform, depth + 1);
            }

            var info = new PanelMeshElementInfo
            {
                ElementId = hostElementId,
                Name = linkName,
                Category = linkCategoryName,
            };
            info.IsGlazed = false;

            int baseVertex = (int)result.TotalVertices;
            long baseIndex = result.TotalIndices;
            var linkSw = System.Diagnostics.Stopwatch.StartNew();
            const int LinkTimeBudgetMs = 8000;
            // Linked faces live in the linked document for GraphicsStyle / Material lookup.
            CutContext linkCut = cutContext?.WithDocument(linkedDoc);
            linkCut?.BeginElement();

            foreach (Element inner in nestedElements)
            {
                if (result.TotalVertices >= MaxVerticesPerBatch)
                {
                    result.Truncated = true;
                    break;
                }

                if (info.VertexCount >= MaxVerticesPerLink)
                {
                    result.Truncated = true;
                    break;
                }

                if (linkSw.ElapsedMilliseconds > LinkTimeBudgetMs)
                {
                    result.Truncated = true;
                    PanelService.Instance.WritePanelLog(
                        $"Extract link time-budget id={hostElementId} ms={linkSw.ElapsedMilliseconds} verts={info.VertexCount}");
                    break;
                }

                try
                {
                    GeometryElement geometry = null;
                    try { geometry = inner.get_Geometry(options); }
                    catch (Exception) { geometry = null; }

                    if (geometry == null)
                        continue;

                    EmitGeometryElement(geometry, linkTransform, 0, result, info, linkCut, MaxVerticesPerLink);
                    info.VertexCount = (int)(result.TotalVertices - baseVertex);
                }
                catch (Exception) { /* keep going; one bad link element must not kill the rest */ }
            }

            FlushDeferredCuts(result, info, linkCut, MaxVerticesPerLink);

            info.VertexCount = (int)(result.TotalVertices - baseVertex);
            info.IndexCount = (int)(result.TotalIndices - baseIndex);

            if (info.VertexCount > 0 && info.IndexCount > 0)
            {
                info.FirstVertex = baseVertex;
                info.FirstIndex = (int)baseIndex;
                PromoteCutIndicesFromPlanes(result, info, linkCut ?? cutContext);
                result.Elements.Add(info);
            }
            else
            {
                result.Positions.RemoveRange(baseVertex * 3, (int)((result.TotalVertices - baseVertex) * 3));
                result.Indices.RemoveRange((int)baseIndex, (int)(result.TotalIndices - baseIndex));
                result.SkippedElements++;
            }
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
            info.IsGlazed = IsLikelyGlazedElement(element);

            int baseVertex = (int)result.TotalVertices;
            long baseIndex = result.TotalIndices;
            cutContext?.BeginElement();

            try
            {
                GeometryElement geometry = null;
                try { geometry = element.get_Geometry(options); }
                catch (Exception) { geometry = null; }

                if (geometry == null)
                {
                    result.SkippedElements++;
                    return;
                }

                // Active simplify: keep the element (pickable) but replace insane meshes with a bbox proxy.
                // Example: Generic Model 639100 = "_Rigged+6700_...Robot+++Faceplate" — tiny bbox, huge nest.
                string simplifyReason = null;
                if (ShouldSimplifyToProxy(element, geometry, out simplifyReason))
                {
                    if (EmitBoundingBoxProxy(element, transform ?? Transform.Identity, result, info))
                    {
                        info.Simplified = true;
                        result.Truncated = true;
                        PanelService.Instance.WritePanelLog(
                            $"Extract simplified id={elementId} cat={categoryName} reason={simplifyReason} proxy=bbox");
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
                    // View-clipped cut faces only appear on instance geometry when Options.View is set.
                    // Symbol geometry stays uncut and would miss section/scope-box caps entirely.
                    if (cutContext != null && cutContext.Enabled)
                    {
                        GeometryElement instanceGeom = null;
                        try { instanceGeom = instance.GetInstanceGeometry(); }
                        catch (Exception) { instanceGeom = null; }

                        if (instanceGeom != null)
                        {
                            EmitGeometryElement(instanceGeom, parent, depth + 1, result, marker, cutContext, elementBudgetOverride);
                            continue;
                        }
                    }

                    Transform combined = instance.Transform;
                    if (parent != null && !parent.IsIdentity)
                        combined = parent.Multiply(combined);

                    EmitGeometryElement(instance.GetSymbolGeometry(), combined, depth + 1, result, marker, cutContext, elementBudgetOverride);
                    continue;
                }

                if (obj is Solid solid)
                {
                    if (solid.Volume <= 0)
                        continue;
                    EmitSolid(solid, parent, result, marker, cutContext, elementBudgetOverride);
                    continue;
                }

                if (obj is Mesh mesh)
                    EmitMesh(mesh, parent, result, marker, elementBudgetOverride);
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
            foreach (Face face in solid.Faces)
            {
                if (marker.FacesEmitted >= MaxFacesPerElement)
                {
                    result.Truncated = true;
                    return;
                }

                if (result.TotalVertices >= MaxVerticesPerBatch)
                {
                    result.Truncated = true;
                    return;
                }

                // 0 = coarsest preview mesh suitable for Agent Canvas.
                Mesh mesh = null;
                try { mesh = face.Triangulate(0); }
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
    }
}
