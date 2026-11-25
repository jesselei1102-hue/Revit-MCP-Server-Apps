using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Serializes packed mesh data to the local panel tmp folder.
    /// The payload stays on this machine; it is never sent over MCP/TCP.
    /// </summary>
    internal static class PanelMeshPayloadWriter
    {
        public static PanelGeometrySummary Write(string tmpDir, PanelMeshResult extraction)
        {
            if (string.IsNullOrWhiteSpace(tmpDir))
                throw new ArgumentException("tmpDir is required", nameof(tmpDir));
            if (extraction == null)
                throw new ArgumentNullException(nameof(extraction));

            Directory.CreateDirectory(tmpDir);
            CleanOldGeometry(tmpDir, keep: null); // fresh extract invalidates the previously loaded mesh, so reclaim old files eagerly

            string fileName = $"geom_{Guid.NewGuid():N}.json";
            return WritePayload(tmpDir, extraction, fileName, delta: false);
        }

        /// <summary>
        /// Incremental payload for DocumentChanged sync. Keeps the currently loaded full-model
        /// file intact; only writes a small delta file carrying the changed elements.
        /// Old delta files are pruned (newest 3 kept) so rapid edits don't pile up.
        /// </summary>
        public static PanelGeometrySummary WriteDelta(string tmpDir, PanelMeshResult extraction)
        {
            if (string.IsNullOrWhiteSpace(tmpDir))
                throw new ArgumentException("tmpDir is required", nameof(tmpDir));
            if (extraction == null)
                throw new ArgumentNullException(nameof(extraction));

            Directory.CreateDirectory(tmpDir);
            PruneDeltaFiles(tmpDir, keep: 3);

            string fileName = $"geom_delta_{Guid.NewGuid():N}.json";
            return WritePayload(tmpDir, extraction, fileName, delta: true);
        }

        private static PanelGeometrySummary WritePayload(string tmpDir, PanelMeshResult extraction, string fileName, bool delta)
        {
            var positions = extraction.Positions.ToArray();
            var indices = extraction.Indices.ToArray();

            byte[] positionsBytes = new byte[positions.Length * sizeof(float)];
            Buffer.BlockCopy(positions, 0, positionsBytes, 0, positionsBytes.Length);

            byte[] indicesBytes = new byte[indices.Length * sizeof(uint)];
            Buffer.BlockCopy(indices, 0, indicesBytes, 0, indicesBytes.Length);

            var elements = new JArray();
            foreach (PanelMeshElementInfo element in extraction.Elements)
            {
                var elementJson = new JObject
                {
                    ["elementId"] = element.ElementId,
                    ["name"] = element.Name ?? string.Empty,
                    ["category"] = element.Category ?? string.Empty,
                    ["isGlazed"] = element.IsGlazed,
                    ["firstVertex"] = element.FirstVertex,
                    ["vertexCount"] = element.VertexCount,
                    ["firstIndex"] = element.FirstIndex,
                    ["indexCount"] = element.IndexCount,
                    ["cutIndexCount"] = element.CutIndexCount,
                };
                if (element.CutColor.HasValue)
                    elementJson["cutColor"] = $"#{element.CutColor.Value:X6}";
                if (element.LevelId.HasValue)
                    elementJson["levelId"] = element.LevelId.Value;
                elements.Add(elementJson);
            }

            var cutPlanes = new JArray();
            if (extraction.CutPlanes != null && extraction.CutPlanes.Count >= 6)
            {
                for (int i = 0; i + 5 < extraction.CutPlanes.Count; i += 6)
                {
                    cutPlanes.Add(new JObject
                    {
                        ["nx"] = extraction.CutPlanes[i],
                        ["ny"] = extraction.CutPlanes[i + 1],
                        ["nz"] = extraction.CutPlanes[i + 2],
                        ["ox"] = extraction.CutPlanes[i + 3],
                        ["oy"] = extraction.CutPlanes[i + 4],
                        ["oz"] = extraction.CutPlanes[i + 5],
                    });
                }
            }

            var sectionCorners = new JArray();
            if (extraction.SectionBoxCorners != null)
            {
                for (int i = 0; i + 2 < extraction.SectionBoxCorners.Count; i += 3)
                {
                    sectionCorners.Add(new JArray(
                        extraction.SectionBoxCorners[i],
                        extraction.SectionBoxCorners[i + 1],
                        extraction.SectionBoxCorners[i + 2]));
                }
            }

            var payload = new JObject
            {
                ["format"] = delta ? "panel-mesh-delta-v1" : "panel-mesh-v1",
                ["coordinateSystem"] = "revit-feet-zup",
                ["elementCount"] = extraction.Elements.Count,
                ["totalVertices"] = extraction.TotalVertices,
                ["totalIndices"] = extraction.TotalIndices,
                ["truncated"] = extraction.Truncated,
                ["skippedElements"] = extraction.SkippedElements,
                ["clientSectionClip"] = extraction.ClientSectionClip,
                ["cutPlanes"] = cutPlanes,
                ["sectionBoxCorners"] = sectionCorners,
                ["elements"] = elements,
                ["levels"] = new JArray(extraction.Levels.Select(l => new JObject { ["id"] = l.Id, ["name"] = l.Name ?? string.Empty, ["elevation"] = l.Elevation })),
                ["positionsB64"] = Convert.ToBase64String(positionsBytes),
                ["indicesB64"] = Convert.ToBase64String(indicesBytes),
            };

            string finalPath = Path.Combine(tmpDir, fileName);
            string tempPath = finalPath + ".tmp";
            File.WriteAllText(tempPath, payload.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8);
            if (File.Exists(finalPath))
                File.Delete(finalPath);
            File.Move(tempPath, finalPath);

            return new PanelGeometrySummary
            {
                FileName = fileName,
                ElementCount = extraction.Elements.Count,
                TotalVertices = extraction.TotalVertices,
                TotalIndices = extraction.TotalIndices,
                Truncated = extraction.Truncated,
                SkippedElements = extraction.SkippedElements,
            };
        }

        public static int CleanOldGeometry(string tmpDir, string keep)
        {
            if (string.IsNullOrWhiteSpace(tmpDir) || !Directory.Exists(tmpDir))
                return 0;

            int deleted = 0;
            foreach (string path in Directory.EnumerateFiles(tmpDir, "geom_*.json*"))
            {
                string name = Path.GetFileName(path);
                if (name.StartsWith("geom_delta_", StringComparison.OrdinalIgnoreCase))
                    continue; // delta files are pruned separately by WriteDelta
                if (!string.IsNullOrEmpty(keep) && string.Equals(name, keep, StringComparison.OrdinalIgnoreCase))
                    continue;

                try
                {
                    File.Delete(path);
                    deleted++;
                }
                catch
                {
                    // A fetch in progress may hold the file; stale files are harmless.
                }
            }

            return deleted;
        }

        /// <summary>
        /// Keep the newest <paramref name="keep"/> delta files; delete older ones.
        /// </summary>
        private static int PruneDeltaFiles(string tmpDir, int keep)
        {
            if (!Directory.Exists(tmpDir))
                return 0;

            var deltas = new DirectoryInfo(tmpDir)
                .EnumerateFiles("geom_delta_*.json")
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Skip(Math.Max(0, keep))
                .ToList();

            int deleted = 0;
            foreach (FileInfo file in deltas)
            {
                try { file.Delete(); deleted++; }
                catch { /* in-flight fetch may hold the file */ }
            }
            return deleted;
        }
    }

    internal sealed class PanelGeometrySummary
    {
        public string FileName { get; set; }
        public int ElementCount { get; set; }
        public long TotalVertices { get; set; }
        public long TotalIndices { get; set; }
        public bool Truncated { get; set; }
        public int SkippedElements { get; set; }
    }

    internal sealed class PanelAnalysisItem
    {
        public long ElementId { get; set; }
        public string Status { get; set; }
        public string Color { get; set; }
        public string Label { get; set; }
        /// <summary>0–1 mesh opacity in the Agent Canvas. Null keeps the panel default.</summary>
        public double? Opacity { get; set; }
    }
}
