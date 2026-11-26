using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Remembers the last mesh payload for a view. A reload of the same view is served from disk
    /// when every extracted element still has the same VersionGuid.
    /// </summary>
    internal static class PanelViewMeshCache
    {
        const int Schema = 8;
        const int MaxEntries = 3;
        const string IndexName = "viewcache_index.json";

        public static string Fingerprint(Document doc, View view, IList<Element> targets)
        {
            long hash = unchecked((long)1469598103934665603);
            void Mix(long value)
            {
                hash ^= value;
                hash *= 1099511628211;
            }

            void MixGuid(Guid guid)
            {
                byte[] bytes = guid.ToByteArray();
                Mix(BitConverter.ToInt64(bytes, 0));
                Mix(BitConverter.ToInt64(bytes, 8));
            }

            Mix(Schema);
            MixString(view?.UniqueId, Mix);
            Mix(view?.Id != null ? PanelElementIds.GetValue(view.Id) : 0);

            if (view is View3D view3d)
            {
                bool boxed = false;
                try { boxed = view3d.IsSectionBoxActive; }
                catch (Exception) { boxed = false; }
                Mix(boxed ? 1 : 0);
                if (boxed)
                {
                    try
                    {
                        BoundingBoxXYZ box = view3d.GetSectionBox();
                        if (box != null)
                        {
                            Mix(Scale(box.Min.X)); Mix(Scale(box.Min.Y)); Mix(Scale(box.Min.Z));
                            Mix(Scale(box.Max.X)); Mix(Scale(box.Max.Y)); Mix(Scale(box.Max.Z));
                        }
                    }
                    catch (Exception) { /* ignore */ }
                }
            }

            var list = targets ?? new List<Element>();
            Mix(list.Count);
            foreach (Element element in list)
            {
                if (element == null)
                    continue;
                try { Mix(PanelElementIds.GetValue(element.Id)); }
                catch (Exception) { continue; }
                try { MixGuid(element.VersionGuid); }
                catch (Exception) { Mix(0); }

                if (element is RevitLinkInstance link)
                    MixLink(link, Mix, MixGuid);
            }

            return hash.ToString("X16");
        }

        public static bool TryLoad(string tmpDir, string key, out PanelGeometrySummary summary)
        {
            summary = null;
            JObject index = ReadIndex(tmpDir);
            JArray entries = index?["entries"] as JArray;
            if (entries == null)
                return false;

            foreach (JObject entry in entries.OfType<JObject>())
            {
                if (!string.Equals(entry.Value<string>("key"), key, StringComparison.Ordinal))
                    continue;
                string file = entry.Value<string>("file");
                if (string.IsNullOrWhiteSpace(file))
                    return false;
                string path = Path.Combine(tmpDir, file);
                if (!File.Exists(path))
                    return false;
                summary = new PanelGeometrySummary
                {
                    FileName = file,
                    ElementCount = entry.Value<int?>("elementCount") ?? 0,
                    TotalVertices = entry.Value<long?>("totalVertices") ?? 0,
                    TotalIndices = entry.Value<long?>("totalIndices") ?? 0,
                    Truncated = entry.Value<bool?>("truncated") ?? false,
                    SkippedElements = entry.Value<int?>("skipped") ?? 0,
                };
                return true;
            }

            return false;
        }

        public static void Remember(string tmpDir, string key, PanelGeometrySummary written)
        {
            if (string.IsNullOrWhiteSpace(tmpDir) || written == null || string.IsNullOrWhiteSpace(written.FileName))
                return;

            Directory.CreateDirectory(tmpDir);
            string source = Path.Combine(tmpDir, written.FileName);
            if (!File.Exists(source))
                return;

            string cachedName = "viewcache_" + key + ".json";
            string cachedPath = Path.Combine(tmpDir, cachedName);
            if (!string.Equals(source, cachedPath, StringComparison.OrdinalIgnoreCase))
                File.Copy(source, cachedPath, overwrite: true);

            JObject index = ReadIndex(tmpDir) ?? new JObject();
            var entries = (index["entries"] as JArray)?.OfType<JObject>().ToList() ?? new List<JObject>();
            entries.RemoveAll(e => string.Equals(e.Value<string>("key"), key, StringComparison.Ordinal));
            entries.Insert(0, new JObject
            {
                ["key"] = key,
                ["file"] = cachedName,
                ["elementCount"] = written.ElementCount,
                ["totalVertices"] = written.TotalVertices,
                ["totalIndices"] = written.TotalIndices,
                ["truncated"] = written.Truncated,
                ["skipped"] = written.SkippedElements,
            });

            var kept = entries.Take(MaxEntries).ToList();
            var drop = entries.Skip(MaxEntries);
            foreach (JObject old in drop)
            {
                string file = old.Value<string>("file");
                if (string.IsNullOrWhiteSpace(file))
                    continue;
                try { File.Delete(Path.Combine(tmpDir, file)); }
                catch (Exception) { /* in use */ }
            }

            index["entries"] = new JArray(kept);
            File.WriteAllText(Path.Combine(tmpDir, IndexName), index.ToString());
        }

        static void MixLink(RevitLinkInstance link, Action<long> mix, Action<Guid> mixGuid)
        {
            Document linked = null;
            try { linked = link.GetLinkDocument(); }
            catch (Exception) { linked = null; }
            if (linked == null)
            {
                mix(0);
                return;
            }

            try { MixString(linked.PathName, mix); }
            catch (Exception) { mix(1); }

            IEnumerable<Element> inners;
            try
            {
                inners = new FilteredElementCollector(linked)
                    .WhereElementIsNotElementType()
                    .ToElements();
            }
            catch (Exception)
            {
                return;
            }

            foreach (Element inner in inners)
            {
                if (inner?.Category == null || inner.Category.CategoryType != CategoryType.Model)
                    continue;
                try { mix(PanelElementIds.GetValue(inner.Id)); }
                catch (Exception) { continue; }
                try { mixGuid(inner.VersionGuid); }
                catch (Exception) { mix(0); }
            }
        }

        static void MixString(string text, Action<long> mix)
        {
            if (string.IsNullOrEmpty(text))
            {
                mix(0);
                return;
            }

            foreach (char c in text)
                mix(c);
        }

        static long Scale(double feet) => (long)Math.Round(feet * 304.8);

        static JObject ReadIndex(string tmpDir)
        {
            try
            {
                string path = Path.Combine(tmpDir ?? string.Empty, IndexName);
                if (!File.Exists(path))
                    return null;
                return JObject.Parse(File.ReadAllText(path));
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static string StableId(Document doc, View view)
        {
            long hash = unchecked((long)1469598103934665603);
            void Mix(long value)
            {
                hash ^= value;
                hash *= 1099511628211;
            }
            Mix(3);
            try { MixString(doc?.PathName, Mix); }
            catch (Exception) { Mix(0); }
            try { MixString(doc?.Title, Mix); }
            catch (Exception) { Mix(0); }
            MixString(view?.UniqueId, Mix);
            MixString(view?.Name, Mix);
            return hash.ToString("X16");
        }

        public static string FileNameFor(string stableId) => "model_" + stableId + ".json";

        public static bool TryUse(string tmpDir, string stableId, string fingerprint, out PanelGeometrySummary summary)
        {
            summary = null;
            string name = FileNameFor(stableId);
            string path = Path.Combine(tmpDir ?? string.Empty, name);
            if (!File.Exists(path))
                return false;
            string head = ReadHead(path, 24000);
            if (head.IndexOf("\"fingerprint\":\"" + fingerprint + "\"", StringComparison.Ordinal) < 0)
                return false;
            summary = new PanelGeometrySummary
            {
                FileName = name,
                ElementCount = ReadInt(head, "elementCount"),
                TotalVertices = ReadLong(head, "totalVertices"),
                TotalIndices = ReadLong(head, "totalIndices"),
                Truncated = head.IndexOf("\"truncated\":true", StringComparison.Ordinal) >= 0,
                SkippedElements = ReadInt(head, "skippedElements"),
            };
            return true;
        }

        public static int NextVersion(string tmpDir, string stableId)
        {
            string path = Path.Combine(tmpDir ?? string.Empty, FileNameFor(stableId));
            if (!File.Exists(path))
                return 1;
            return Math.Max(1, ReadInt(ReadHead(path, 8000), "version") + 1);
        }

        static string ReadHead(string path, int bytes)
        {
            try
            {
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    int n = (int)Math.Min(bytes, stream.Length);
                    var buffer = new byte[n];
                    stream.Read(buffer, 0, n);
                    return System.Text.Encoding.UTF8.GetString(buffer);
                }
            }
            catch (Exception)
            {
                return string.Empty;
            }
        }

        static int ReadInt(string head, string name)
        {
            var match = System.Text.RegularExpressions.Regex.Match(head ?? string.Empty, "\"" + name + "\"\\s*:\\s*(-?\\d+)");
            return match.Success ? int.Parse(match.Groups[1].Value) : 0;
        }

        static long ReadLong(string head, string name)
        {
            var match = System.Text.RegularExpressions.Regex.Match(head ?? string.Empty, "\"" + name + "\"\\s*:\\s*(-?\\d+)");
            return match.Success ? long.Parse(match.Groups[1].Value) : 0;
        }
    }
}
