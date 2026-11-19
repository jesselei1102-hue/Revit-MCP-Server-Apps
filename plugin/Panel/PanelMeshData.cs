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

        /// <summary>Vertex offset (in vertices, not floats) into Positions.</summary>
        public int FirstVertex { get; set; }

        /// <summary>Number of vertices belonging to this element.</summary>
        public int VertexCount { get; set; }

        /// <summary>Offset (in indices) into Indices.</summary>
        public int FirstIndex { get; set; }

        /// <summary>Number of indices belonging to this element.</summary>
        public int IndexCount { get; set; }
    }

    /// <summary>
    /// Result of a mesh extraction pass. Positions are in feet, Z-up (Revit internal coordinates).
    /// </summary>
    internal sealed class PanelMeshResult
    {
        public List<PanelMeshElementInfo> Elements { get; } = new();
        public List<float> Positions { get; } = new();   // x, y, z ...
        public List<uint> Indices { get; } = new();      // triangle indices into Positions

        public bool Truncated { get; set; }
        public int SkippedElements { get; set; }

        public long TotalVertices => Positions.Count / 3;
        public long TotalIndices => Indices.Count;
    }
}
