using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Core;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Maps MCP App tool calls from the embedded Schedule / GBP iframes onto Revit commands
    /// (and a few server-shaped responses assembled in-process).
    /// </summary>
    internal static class PanelAppToolRouter
    {
        private static readonly HashSet<string> Passthrough = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "query_model",
            "get_element_data",
            "get_available_family_types",
            "operate_element",
            "select_elements",
            "zoom_to_elements",
            "color_elements",
            "get_selected_elements",
            "get_current_view_info",
            "get_current_view_elements",
            "ai_element_filter",
            "rules_list",
            "rules_set_enabled",
            "rules_upsert",
            "rules_import_checkset",
            "checks_run",
            "checks_get_results",
        };

        public static object Invoke(string toolName, JObject args)
        {
            if (string.IsNullOrWhiteSpace(toolName))
                throw new ArgumentException("tool name is required");

            args = args ?? new JObject();

            if (string.Equals(toolName, "mcp_apps_get_schedule_data", StringComparison.OrdinalIgnoreCase))
            {
                string detail = args.Value<string>("detail");
                // Default (and explicit "summary") = counts only. App reloads with detail:"full".
                if (!string.Equals(detail, "full", StringComparison.OrdinalIgnoreCase))
                    return LoadScheduleSummary(args);
                return LoadScheduleData(args);
            }

            if (string.Equals(toolName, "choose_checks", StringComparison.OrdinalIgnoreCase))
                return LoadGbpChoose(args);

            if (Passthrough.Contains(toolName))
                return SocketService.Instance.ExecuteMethod(toolName, args);

            // Unknown tools: soft stub so the Ultraviolet UI stays up.
            return new
            {
                Success = false,
                Message = "Tool '" + toolName + "' is not available inside the Agent Canvas host yet.",
            };
        }

        private static object LoadScheduleSummary(JObject args)
        {
            // Counts only — no row payloads. Keeps WebView init off the Revit API hot path.
            JObject queryParams = new JObject
            {
                ["input"] = new JObject
                {
                    ["searchScope"] = args.Value<string>("searchScope") ?? "AllViews",
                    ["elementInclusionMode"] = "InstancesOnly",
                    ["maxResults"] = 0,
                    ["includeLinkedModels"] = args.Value<bool?>("includeLinkedModels") ?? true,
                },
            };

            object query = SocketService.Instance.ExecuteMethod("query_model", queryParams);
            var queryToken = query as JToken ?? JToken.FromObject(query ?? new { });
            var elementIds = new List<long>();
            CollectElementIds(queryToken, elementIds);

            return new JObject
            {
                ["detail"] = "summary",
                ["matchedCount"] = elementIds.Count,
                ["totalMatched"] = elementIds.Count,
                ["truncated"] = false,
                ["linkedMatchedCount"] = 0,
                ["loadedLinkCount"] = 0,
                ["unloadedLinkCount"] = 0,
                ["byCategory"] = new JObject(),
                ["dashboard"] = new JObject
                {
                    ["errorCount"] = 0,
                    ["warningCount"] = 0,
                    ["detachableFamilyCount"] = 0,
                },
                ["message"] = "Summary · " + elementIds.Count + " elements (panel host). App will load rows with detail full.",
            };
        }

        private static object LoadScheduleData(JObject args)
        {
            // Prefer the same Revit commands the Node Schedule app uses; flatten lightly for the table.
            JObject queryParams = new JObject
            {
                ["input"] = new JObject
                {
                    ["searchScope"] = args.Value<string>("searchScope") ?? "AllViews",
                    ["elementInclusionMode"] = "InstancesOnly",
                    ["categories"] = args["categories"] ?? new JArray(),
                    ["maxResults"] = 0,
                    ["includeLinkedModels"] = args.Value<bool?>("includeLinkedModels") ?? true,
                },
            };

            // Empty categories → let commandset defaults apply by omitting the key.
            if (queryParams["input"]?["categories"] is JArray cats && cats.Count == 0)
                ((JObject)queryParams["input"]).Remove("categories");

            object query = SocketService.Instance.ExecuteMethod("query_model", queryParams);
            var queryToken = query as JToken ?? JToken.FromObject(query ?? new { });
            var elementIds = new List<long>();
            CollectElementIds(queryToken, elementIds);

            JArray explicitIds = args["elementIds"] as JArray;
            if (explicitIds != null && explicitIds.Count > 0)
            {
                elementIds.Clear();
                foreach (JToken id in explicitIds)
                {
                    long value = id.Value<long?>() ?? 0;
                    if (value > 0) elementIds.Add(value);
                }
            }

            int limit = args.Value<int?>("maxResults") ?? 0;
            if (limit > 0 && elementIds.Count > limit)
                elementIds = elementIds.GetRange(0, limit);

            var rows = new List<JObject>();
            const int batch = 80;
            for (int i = 0; i < elementIds.Count; i += batch)
            {
                int count = Math.Min(batch, elementIds.Count - i);
                var batchIds = new JArray();
                for (int j = 0; j < count; j++)
                    batchIds.Add(elementIds[i + j]);

                JObject dataParams = new JObject
                {
                    ["elementIds"] = batchIds,
                    ["outputOptions"] = new JObject
                    {
                        ["basicElementInfo"] = true,
                        ["parametersOutputType"] = args.Value<string>("parametersOutputType")
                            ?? "EditableInstanceParameters",
                    },
                };

                object data = SocketService.Instance.ExecuteMethod("get_element_data", dataParams);
                var dataToken = data as JToken ?? JToken.FromObject(data ?? new { });
                JArray elements = dataToken["elements"] as JArray
                    ?? dataToken["Elements"] as JArray
                    ?? new JArray();
                foreach (JToken el in elements)
                {
                    if (el is not JObject obj) continue;
                    rows.Add(FlattenElement(obj));
                }
            }

            var columns = new JArray
            {
                "elementId", "link", "name", "category", "family", "type", "level", "Mark", "Comments",
            };

            return new JObject
            {
                ["columns"] = columns,
                ["rows"] = new JArray(rows),
                ["matchedCount"] = rows.Count,
                ["totalMatched"] = elementIds.Count,
                ["truncated"] = false,
                ["message"] = "Loaded from Agent Canvas · " + rows.Count + " rows",
                ["dashboard"] = new JObject
                {
                    ["errorCount"] = 0,
                    ["warningCount"] = 0,
                    ["detachableFamilyCount"] = 0,
                },
            };
        }

        private static void CollectElementIds(JToken root, List<long> into)
        {
            if (root == null) return;
            JArray ids = root["elementIds"] as JArray
                ?? root["results"]?["elementIds"] as JArray
                ?? root["Results"]?["elementIds"] as JArray;
            if (ids != null)
            {
                foreach (JToken id in ids)
                {
                    long value = id.Type == JTokenType.Object
                        ? (id.Value<long?>("elementId") ?? id.Value<long?>("id") ?? 0)
                        : (id.Value<long?>() ?? 0);
                    if (value > 0) into.Add(value);
                }
            }

            JArray elements = root["elements"] as JArray;
            if (elements != null)
            {
                foreach (JToken el in elements)
                {
                    long value = el.Value<long?>("elementId") ?? el.Value<long?>("id") ?? 0;
                    if (value > 0) into.Add(value);
                }
            }
        }

        private static JObject FlattenElement(JObject el)
        {
            long id = el.Value<long?>("elementId")
                ?? el.Value<long?>("ElementId")
                ?? el.Value<long?>("id")
                ?? 0;
            string link = el.Value<string>("linkName")
                ?? el.Value<string>("link")
                ?? "";
            string name = el.Value<string>("name") ?? el.Value<string>("Name") ?? "";
            string category = el.Value<string>("category") ?? el.Value<string>("Category") ?? "";
            string family = el.Value<string>("familyName") ?? el.Value<string>("family") ?? "";
            string type = el.Value<string>("typeName") ?? el.Value<string>("type") ?? "";
            string level = el.Value<string>("level") ?? el.Value<string>("Level") ?? "";

            string mark = "";
            string comments = "";
            JToken parameters = el["parameters"] ?? el["Parameters"];
            if (parameters is JObject pobj)
            {
                mark = pobj.Value<string>("Mark") ?? pobj.Value<string>("标记") ?? "";
                comments = pobj.Value<string>("Comments") ?? pobj.Value<string>("注释") ?? "";
            }
            else if (parameters is JArray parr)
            {
                foreach (JToken p in parr)
                {
                    string pname = p.Value<string>("name") ?? p.Value<string>("Name") ?? "";
                    string pval = p.Value<string>("value") ?? p.Value<string>("Value") ?? "";
                    if (string.Equals(pname, "Mark", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(pname, "标记", StringComparison.OrdinalIgnoreCase))
                        mark = pval;
                    if (string.Equals(pname, "Comments", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(pname, "注释", StringComparison.OrdinalIgnoreCase))
                        comments = pval;
                }
            }

            return new JObject
            {
                ["elementId"] = id.ToString(),
                ["link"] = link,
                ["linkInstanceId"] = "",
                ["name"] = name,
                ["category"] = category,
                ["family"] = family,
                ["type"] = type,
                ["level"] = level,
                ["Mark"] = mark,
                ["Comments"] = comments,
            };
        }

        private static object LoadGbpChoose(JObject args)
        {
            // Embedded GBP UI expects the choose_checks shaped payload.
            // Full audit execution still runs via the gbp-audit MCP server in Cursor;
            // the canvas hosts the Ultraviolet chooser against a local catalogue snapshot.
            string cataloguePath = System.IO.Path.Combine(
                PanelService.Instance.PanelFolder,
                "apps",
                "gbp",
                "catalogue.json");

            if (System.IO.File.Exists(cataloguePath))
            {
                string json = System.IO.File.ReadAllText(cataloguePath);
                return JToken.Parse(json);
            }

            return new JObject
            {
                ["view"] = "choose",
                ["runsRoot"] = "(panel)",
                ["groups"] = new JArray(),
                ["checks"] = new JArray(),
                ["outputs"] = new JArray(),
                ["message"] = "GBP catalogue not found in panel-view/apps/gbp. Copy catalogue.json from the GBP audit app build.",
            };
        }
    }
}
