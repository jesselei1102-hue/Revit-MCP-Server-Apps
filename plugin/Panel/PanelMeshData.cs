using System.Collections.Generic;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// One element's mesh range inside the packed buffers.
    /// </summary>
    internal sealed class PanelMeshElementInfo
    {
        public long ElementId { get; set; }
        public string Name { get; set; }
        public string Category { get; set; }
        public bool IsGlazed { get; set; }
        /// <summary>True when this element used a simplified proxy mesh (e.g. bbox) instead of full solids.</summary>
        public bool Simplified { get; set; }

        /// <summary>Vertex offset (in vertices, not floats) into Positions.</summary>
        public int FirstVertex { get; set; }

        /// <summary>Number of vertices belonging to this element.</summary>
        public int VertexCount { get; set; }

        /// <summary>Offset (in indices) into Indices.</summary>
        public int FirstIndex { get; set; }

        /// <summary>Number of indices belonging to this element.</summary>
        public int IndexCount { get; set; }

        /// <summary>
        /// Trailing index count for section/scope-box cut faces (emitted after surface faces).
        /// 0 = no cut faces. Frontend uses a distinct cut material for this range.
        /// </summary>
        public int CutIndexCount { get; set; }

        /// <summary>
        /// Optional 0xRRGGBB cut fill from the face material. Null → panel default cut gray.
        /// </summary>
        public int? CutColor { get; set; }

        /// <summary>
        /// Optional 0xRRGGBB surface colour (MEP system type / view override). Null → role default.
        /// </summary>
        public int? DisplayColor { get; set; }

        /// <summary>Faces successfully triangulated for this element (runtime extract budget).</summary>
        public int FacesEmitted { get; set; }

        /// <summary>MEP curve/fitting: keep a higher face budget so elbows are not cut off.</summary>
        public bool HighDetail { get; set; }

        /// <summary>This mesh is one Revit link instance (the whole linked model).</summary>
        public bool IsLink { get; set; }

        /// <summary>Host RevitLinkInstance id, so several category meshes toggle as one link.</summary>
        public long? LinkInstanceId { get; set; }

        /// <summary>Unique mesh key when several parts share ElementId (link category buckets).</summary>
        public string MeshKey { get; set; }

        public string FamilyName { get; set; }
        public string TypeName { get; set; }
        public string ModelName { get; set; }

        /// <summary>0 = coarsest. Lights use 1 so curved shades stay smooth.</summary>
        public double TessellationLod { get; set; }

        /// <summary>Wall / floor / roof / window: keep the real solid so openings stay cut out.</summary>
        public bool KeepSolid { get; set; }

        /// <summary>Level the element belongs to (its LevelId, or the level just below its bounding box). Null for links and unplaced elements.</summary>
        public long? LevelId { get; set; }
    }

    /// <summary>
    /// A building level, so the Agent Canvas can stack, explode or cut the model by storey.
    /// Elevation is in feet (Revit internal units).
    /// </summary>
    internal sealed class PanelMeshLevel
    {
        public long Id { get; set; }
        public string Name { get; set; }
        public double Elevation { get; set; }
    }

    /// <summary>
    /// Result of a mesh extraction pass. Positions are in feet, Z-up (Revit internal coordinates).
    /// </summary>
    internal sealed class PanelMeshResult
    {
        public List<PanelMeshElementInfo> Elements { get; } = new();
        public List<float> Positions { get; } = new();   // x, y, z ...
        public List<uint> Indices { get; } = new();      // triangle indices into Positions

        /// <summary>
        /// Section / scope-box planes in model space (nx,ny,nz,ox,oy,oz).
        /// Panel clips with these (Three.js) — do not rely on Options.View for the cut.
        /// </summary>
        public List<float> CutPlanes { get; } = new();

        /// <summary>Eight section-box corners in model space (x,y,z × 8) for camera fit. Empty if inactive.</summary>
        public List<float> SectionBoxCorners { get; } = new();

        /// <summary>True when the panel should clip with CutPlanes instead of Revit Options.View.</summary>
        public bool ClientSectionClip { get; set; }

        public bool Truncated { get; set; }
        public int SkippedElements { get; set; }
        /// <summary>Levels of the host document, lowest first.</summary>
        public List<PanelMeshLevel> Levels { get; } = new();

        public long TotalVertices => Positions.Count / 3;
        public long TotalIndices => Indices.Count;
    }
}
