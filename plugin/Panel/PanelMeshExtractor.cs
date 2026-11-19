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

        /// <summary>
        /// Heuristic: element has at least one face whose material is (a) class "Glass" or
        /// (b) name contains "glass"/"glaz", or (c) Transparency >= 50.
        /// Same path that finished Snowdon in ~2–3s this morning.
        /// </summary>
        private static bool IsLikelyGlazedElement(Element element)
        {
            if (element == null) return false;
            Document doc = element.Document;
            if (doc == null) return false;

            var materialIds = new HashSet<ElementId>();
            try
            {
                Options options = new Options { DetailLevel = ViewDetailLevel.Coarse, IncludeNonVisibleObjects = false, ComputeReferences = false };
                GeometryElement geometry = null;
                try { geometry = element.get_Geometry(options); } catch (Exception) { geometry = null; }
                if (geometry != null) CollectFaceMaterialIds(geometry, 0, materialIds);
            }
            catch (Exception) { /* fall through */ }

            if (materialIds.Count == 0)
                return false;

            foreach (ElementId id in materialIds)
            {
                if (id == null || id == ElementId.InvalidElementId) continue;
                Material material = doc.GetElement(id) as Material;
                if (material == null) continue;
                string cls = (material.MaterialClass ?? string.Empty).Trim();
                string cat = (material.MaterialCategory ?? string.Empty).Trim();
                string name = (material.Name ?? string.Empty).Trim();
                int transparency = material.Transparency;

                if (string.Equals(cls, "Glass", StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(cat, "Glass", StringComparison.OrdinalIgnoreCase)) return true;
                if (name.IndexOf("glass", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (name.IndexOf("glaz", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (transparency >= 50) return true;
            }

            return false;
        }

        private static void CollectFaceMaterialIds(GeometryElement geometry, int depth, HashSet<ElementId> materialIds)
        {
            if (geometry == null || depth > MaxDepth) return;
            foreach (GeometryObject obj in geometry)
            {
                if (obj is GeometryInstance instance)
                {
                    CollectFaceMaterialIds(instance.GetSymbolGeometry(), depth + 1, materialIds);
                    continue;
                }
                if (obj is Solid solid)
                {
                    foreach (Face face in solid.Faces)
                    {
                        try
                        {
                            ElementId id = face.MaterialElementId;
                            if (id != null) materialIds.Add(id);
                        }
                        catch (Exception) { /* skip face */ }
                    }
                }
            }
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
                    try { id = new ElementId(idValue); }
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

        public static PanelMeshResult Extract(Document doc, IList<Element> elements)
        {
            var result = new PanelMeshResult();
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var options = new Options
            {
                DetailLevel = ViewDetailLevel.Coarse,
                IncludeNonVisibleObjects = false,
                ComputeReferences = false,
            };

            PanelService.Instance.WritePanelLog($"Extract start count={elements?.Count ?? 0}");

            int index = 0;
            foreach (Element element in elements)
            {
                index++;
                if (element == null)
                {
                    result.SkippedElements++;
                    continue;
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
                    long t0 = sw.ElapsedMilliseconds;
                    PanelService.Instance.WritePanelLog("Extract link start id=" + linkInstance.Id.Value);
                    ExtractLinkInstance(doc, linkInstance, options, result);
                    PanelService.Instance.WritePanelLog($"Extract link done id={linkInstance.Id.Value} verts={result.TotalVertices} linkMs={sw.ElapsedMilliseconds - t0} elapsedMs={sw.ElapsedMilliseconds}");
                    continue;
                }

                EmitElement(element, element.Id.Value, element.Category?.Name, element.Name,
                    Transform.Identity, options, result);
            }

            PanelService.Instance.WritePanelLog($"Extract done elements={result.Elements.Count} skipped={result.SkippedElements} verts={result.TotalVertices} elapsedMs={sw.ElapsedMilliseconds}");
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

            long hostElementId = linkInstance.Id.Value;
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
                ExtractLinkInstance(hostDocument, nested, options, result, linkTransform, depth + 1);
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

                    EmitGeometryElement(geometry, linkTransform, 0, result, info, MaxVerticesPerLink);
                    info.VertexCount = (int)(result.TotalVertices - baseVertex);
                }
                catch (Exception) { /* keep going; one bad link element must not kill the rest */ }
            }

            info.VertexCount = (int)(result.TotalVertices - baseVertex);
            info.IndexCount = (int)(result.TotalIndices - baseIndex);

            if (info.VertexCount > 0 && info.IndexCount > 0)
            {
                info.FirstVertex = baseVertex;
                info.FirstIndex = (int)baseIndex;
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
            PanelMeshResult result)
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

                EmitGeometryElement(geometry, transform ?? Transform.Identity, 0, result, info);

                info.VertexCount = (int)(result.TotalVertices - baseVertex);
                info.IndexCount = (int)(result.TotalIndices - baseIndex);

                if (info.VertexCount > 0 && info.IndexCount > 0)
                {
                    info.FirstVertex = baseVertex;
                    info.FirstIndex = (int)baseIndex;
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

        private static void EmitGeometryElement(
            GeometryElement geometry,
            Transform parent,
            int depth,
            PanelMeshResult result,
            PanelMeshElementInfo marker,
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
                    Transform combined = instance.Transform;
                    if (parent != null && !parent.IsIdentity)
                        combined = parent.Multiply(combined);

                    EmitGeometryElement(instance.GetSymbolGeometry(), combined, depth + 1, result, marker, elementBudgetOverride);
                    continue;
                }

                if (obj is Solid solid)
                {
                    if (solid.Volume <= 0)
                        continue;
                    EmitSolid(solid, parent, result, marker, elementBudgetOverride);
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
            long elementBudgetOverride)
        {
            foreach (Face face in solid.Faces)
            {
                if (result.TotalVertices >= MaxVerticesPerBatch)
                {
                    result.Truncated = true;
                    return;
                }

                Mesh mesh = null;
                try { mesh = face.Triangulate(0.05); }
                catch (Exception) { /* skip this face */ }

                EmitMesh(mesh, parent, result, marker, elementBudgetOverride);
            }
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
    }
}
