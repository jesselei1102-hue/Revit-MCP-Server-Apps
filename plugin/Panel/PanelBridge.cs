using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Shared panel state: last loaded mesh, last analysis, last pick, and a WebView2
    /// message pump. Everything here stays in-process; meshes are sent to the WebView
    /// as a local file URL, never over MCP/TCP.
    /// </summary>
    internal static class PanelBridge
    {
        private static readonly object Sync = new();

        public static PanelGeometrySummary LastGeometry { get; private set; }
        public static List<PanelAnalysisItem> LastAnalysis { get; private set; } = new();
        public static JArray LastAnnotations { get; private set; } = new();
        public static JObject LastReport { get; private set; }
        /// <summary>Last Result Spec (revit-result/1) shown on the Agent Canvas.</summary>
        public static JObject LastResult { get; private set; }
        public static string ActiveView { get; private set; } = "model";
        public static long? LastPickElementId { get; private set; }
        public static DateTime? LastPickAtUtc { get; private set; }
        public static string LastError { get; private set; }
        public static string LastGeometryToken { get; private set; }

        /// <summary>
        /// Instruction posted by an embedded MCP App (GBP Run / Schedule) for the Cursor agent to claim.
        /// </summary>
        public static string PendingAgentInstruction { get; private set; }
        public static string PendingAgentInstructionSource { get; private set; }
        public static DateTime? PendingAgentInstructionAtUtc { get; private set; }

        // Source document of the currently loaded mesh, recorded at extraction time.
        // Used by PanelDocumentSync to ignore DocumentChanged events for other open documents.
        public static string ActiveDocumentPath { get; private set; }
        public static string ActiveDocumentToken { get; private set; }
        private static PickRequest _pendingPick;
        private static readonly ManualResetEventSlim CaptureGate = new(false);
        private static string _pendingCaptureRequestId;
        private static PanelCaptureResult _pendingCaptureResult;
        private static PanelCaptureResult _lastUserCapture;
        private static DateTime? _lastUserCaptureAtUtc;
        private static string _lastUserCaptureFilePath;
        private static string _lastUserCaptureFileName;

        public static void RegisterWebView(Microsoft.Web.WebView2.Wpf.WebView2 webView)
        {
            if (webView == null)
                return;

            webView.CoreWebView2.WebMessageReceived += (_, args) =>
            {
                string json = args.WebMessageAsJson;
                HandleJsMessage(json);
            };
        }

        public static void PostToJs(string type, object payload, string token = null)
        {
            string message;
            using (var stringWriter = new System.IO.StringWriter())
            using (var jsonWriter = new Newtonsoft.Json.JsonTextWriter(stringWriter))
            {
                jsonWriter.WriteStartObject();
                jsonWriter.WritePropertyName("token");
                jsonWriter.WriteValue(token ?? LastGeometryToken ?? Guid.NewGuid().ToString("N"));
                jsonWriter.WritePropertyName("type");
                jsonWriter.WriteValue(type);
                jsonWriter.WritePropertyName("payload");
                Newtonsoft.Json.JsonSerializer.CreateDefault().Serialize(jsonWriter, payload ?? new { });
                jsonWriter.WriteEndObject();
                jsonWriter.Flush();
                message = stringWriter.ToString();
            }

            PanelService.Instance.PostWebMessage(message);
        }

        public static void SetActiveDocument(Document doc)
        {
            if (doc == null)
            {
                ActiveDocumentPath = null;
                ActiveDocumentToken = null;
                return;
            }

            try { ActiveDocumentPath = doc.PathName; }
            catch { ActiveDocumentPath = null; }

            try { ActiveDocumentToken = doc.Title; }
            catch { ActiveDocumentToken = null; }
        }

        public static void PostGeometryReady(PanelGeometrySummary summary)
        {
            LastGeometry = summary;
            LastGeometryToken = Guid.NewGuid().ToString("N");
            PostToJs("geometry_ready", new
            {
                url = $"https://panel.local/tmp/{summary.FileName}",
                elementCount = summary.ElementCount,
                totalVertices = summary.TotalVertices,
                totalIndices = summary.TotalIndices,
                truncated = summary.Truncated,
                skippedElements = summary.SkippedElements,
            }, LastGeometryToken);
        }

        /// <summary>
        /// Incremental sync from DocumentChanged: tell the panel which elements disappeared,
        /// which were re-extracted, and where the delta mesh file is (if any).
        /// deletedIds may be non-empty even when there is no delta file.
        /// </summary>
        public static void PostGeometryDelta(IList<long> deletedIds, IList<long> reExtractedIds, PanelGeometrySummary delta)
        {
            var payload = new
            {
                deletedIds = deletedIds?.ToArray() ?? new long[0],
                upsertIds = reExtractedIds?.ToArray() ?? new long[0],
                deltaFile = delta?.FileName,
                url = delta != null ? $"https://panel.local/tmp/{delta.FileName}" : null,
                elementCount = delta?.ElementCount ?? 0,
            };

            PostToJs("geometry_delta", payload);
        }

        public static double? LastAnalysisDefaultOpacity { get; private set; }

        public static void PostSetAnalysis(IList<PanelAnalysisItem> items, double? defaultOpacity = null, bool setDefaultOpacity = false)
        {
            LastAnalysis = items != null ? new List<PanelAnalysisItem>(items) : new List<PanelAnalysisItem>();
            if (setDefaultOpacity)
                LastAnalysisDefaultOpacity = defaultOpacity;

            PostToJs("set_analysis", new
            {
                items = LastAnalysis,
                defaultOpacity = setDefaultOpacity ? defaultOpacity : null,
                clearDefaultOpacity = setDefaultOpacity && defaultOpacity == null,
            });
        }

        /// <summary>
        /// Push 3D measure / annotation overlays into the Model pane
        /// (point-point, point-plane, plane-plane, angle, marker). Coordinates are Revit feet.
        /// </summary>
        public static void PostSetAnnotations(JArray items)
        {
            LastAnnotations = items != null ? (JArray)items.DeepClone() : new JArray();
            PostToJs("set_annotations", new { items = LastAnnotations });
        }

        public static void PostClear(string target)
        {
            if (string.Equals(target, "model", StringComparison.OrdinalIgnoreCase)
                || string.Equals(target, "all", StringComparison.OrdinalIgnoreCase))
            {
                LastGeometry = null;
                ActiveDocumentPath = null;
                ActiveDocumentToken = null;
                LastAnalysis = new List<PanelAnalysisItem>();
                LastAnalysisDefaultOpacity = null;
                LastAnnotations = new JArray();
            }

            if (string.Equals(target, "annotations", StringComparison.OrdinalIgnoreCase)
                || string.Equals(target, "dimensions", StringComparison.OrdinalIgnoreCase))
            {
                LastAnnotations = new JArray();
            }

            if (string.Equals(target, "report", StringComparison.OrdinalIgnoreCase)
                || string.Equals(target, "all", StringComparison.OrdinalIgnoreCase))
            {
                LastReport = null;
            }

            PostToJs("clear", new { target = target ?? "all" });
        }

        public static void PostFit()
        {
            PostToJs("fit", new { });
        }

        /// <summary>
        /// Zoom the Model camera to a world-space target (Revit feet). Optional radius controls framing distance.
        /// </summary>
        public static void PostZoom(object target, double? radius = null, object size = null)
        {
            PostToJs("zoom", new { target, radius, size });
        }

        /// <summary>
        /// Push a structured Ultraviolet report into the Agent Canvas Report pane.
        /// Payload is JSON only (no mesh); html fragments are optional and capped by the MCP tool.
        /// </summary>
        public static object PostSetReport(JObject report, bool switchView = true)
        {
            // Static report presentation on the main WebView (not the Schedule MCP App surface).
            if (switchView)
            {
                ActiveView = "report";
                PanelService.Instance.SetSurface("report");
            }

            if (report == null)
            {
                LastReport = null;
                PostToJs("set_report", new { report = (object)null, switchView });
                return new { ok = true, empty = true, view = switchView ? "report" : ActiveView, mode = "static" };
            }

            LastReport = (JObject)report.DeepClone();
            PostToJs("set_report", new { report = LastReport, switchView });
            return new
            {
                ok = true,
                empty = false,
                view = ActiveView,
                mode = "static",
                title = LastReport.Value<string>("title"),
                kind = LastReport.Value<string>("kind") ?? LastReport.Value<string>("type"),
            };
        }

        /// <summary>
        /// Show an agent result (Result Spec, revit-result/1) on the model-first canvas.
        /// The MCP server validates it against RPS-1 before it gets here; the page validates it again
        /// and draws it in the model. If no model is loaded yet, the page asks for the active view first.
        /// </summary>
        public static object PostSetResult(JObject spec)
        {
            if (spec == null)
                return new { ok = false, error = "missing_result", message = "No result was supplied." };
            LastResult = (JObject)spec.DeepClone();
            ActiveView = "model";
            PanelService.Instance.SetSurface("model");
            PostToJs("set_result", new { spec = LastResult });
            return new
            {
                ok = true,
                title = LastResult.Value<string>("title") ?? LastResult.Value<string>("question"),
                layout = LastResult["presentation"]?.Value<string>("layout"),
                subjects = (LastResult["subjects"] as JArray)?.Count ?? 0,
                modelLoaded = LastGeometry != null,
            };
        }

        public static object PostSetView(string view)
        {
            string raw = (view ?? "model").Trim().ToLowerInvariant();
            // Agent Canvas hosts Model + Dynamic Report only. Schedule/GBP stay in Cursor MCP Apps.
            if (raw == "schedule" || raw == "gbp")
            {
                return new
                {
                    ok = false,
                    error = "view_not_in_panel",
                    message = "Agent Canvas only hosts model and report. Use the Schedule / GBP MCP Apps in Cursor chat.",
                    view = ActiveView,
                };
            }

            string next = raw == "report" ? "report" : "model";
            ActiveView = next;
            PanelService.Instance.SetSurface(next);
            PostToJs("set_view", new { view = next });
            return new { ok = true, view = next, mode = "static", surface = "main" };
        }

        /// <summary>
        /// Ask the WebView to snapshot the current Three.js frame and wait for the result.
        /// Must be called from a non-UI thread (socket command thread) so the WebView
        /// message callback can run on the UI thread without deadlock.
        /// </summary>
        public static object Capture(JObject parameters, int timeoutMilliseconds = 20000)
        {
            string source = parameters?.Value<string>("source");
            if (string.Equals(source, "user", StringComparison.OrdinalIgnoreCase)
                || string.Equals(source, "lastUser", StringComparison.OrdinalIgnoreCase))
            {
                return GetLastUserCapture();
            }

            if (!PanelService.Instance.WebViewReady)
            {
                return new
                {
                    ok = false,
                    error = "webview_not_ready",
                    message = "Agent Canvas WebView is not ready yet. Open the Panel ribbon button first.",
                };
            }

            string format = parameters?.Value<string>("format") ?? "png";
            double? quality = parameters?.Value<double?>("quality");
            int? maxWidth = parameters?.Value<int?>("maxWidth");
            int? maxHeight = parameters?.Value<int?>("maxHeight");
            bool saveFile = parameters?.Value<bool?>("saveFile") ?? true;

            string requestId = Guid.NewGuid().ToString("N");
            lock (Sync)
            {
                _pendingCaptureRequestId = requestId;
                _pendingCaptureResult = null;
                CaptureGate.Reset();
            }

            PostToJs("capture", new
            {
                requestId,
                format,
                quality = quality ?? 0.9,
                maxWidth = maxWidth ?? 1600,
                maxHeight = maxHeight ?? 1600,
            }, requestId);

            if (!CaptureGate.Wait(timeoutMilliseconds))
            {
                lock (Sync)
                {
                    if (_pendingCaptureRequestId == requestId)
                        _pendingCaptureRequestId = null;
                }

                return new
                {
                    ok = false,
                    error = "capture_timeout",
                    message = $"Timed out waiting for panel capture after {timeoutMilliseconds} ms.",
                    requestId,
                };
            }

            PanelCaptureResult capture;
            lock (Sync)
            {
                capture = _pendingCaptureResult;
                _pendingCaptureRequestId = null;
                _pendingCaptureResult = null;
            }

            if (capture == null)
            {
                return new
                {
                    ok = false,
                    error = "capture_empty",
                    message = "Panel returned no capture payload.",
                    requestId,
                };
            }

            if (!capture.Ok)
            {
                return new
                {
                    ok = false,
                    error = capture.Error ?? "capture_failed",
                    message = capture.Message,
                    requestId,
                };
            }

            string fileName = null;
            string filePath = null;
            if (saveFile && !string.IsNullOrEmpty(capture.DataBase64))
            {
                try
                {
                    string folder = PanelService.Instance.PanelTmpFolder;
                    Directory.CreateDirectory(folder);
                    string ext = string.Equals(capture.MimeType, "image/jpeg", StringComparison.OrdinalIgnoreCase)
                        ? "jpg"
                        : "png";
                    fileName = "capture_" + requestId + "." + ext;
                    filePath = Path.Combine(folder, fileName);
                    File.WriteAllBytes(filePath, Convert.FromBase64String(capture.DataBase64));
                    PanelService.Instance.WritePanelLog(
                        $"panel_capture saved {fileName} {capture.Width}x{capture.Height} bytes={capture.ByteLength}");
                }
                catch (Exception ex)
                {
                    PanelService.Instance.WritePanelLog("panel_capture_save_failed: " + ex.Message);
                }
            }

            return new
            {
                ok = true,
                requestId,
                mimeType = capture.MimeType,
                width = capture.Width,
                height = capture.Height,
                byteLength = capture.ByteLength,
                dataBase64 = capture.DataBase64,
                fileName,
                filePath,
                elementCount = capture.ElementCount,
                totalVertices = capture.TotalVertices,
                camera = capture.Camera,
            };
        }

        public static object GetStatus()
        {
            lock (Sync)
            {
                return new
                {
                    ready = PanelService.Instance.WebViewReady,
                    view = ActiveView ?? "model",
                    mode = string.IsNullOrEmpty(PanelService.Instance.ActiveApp)
                        ? "static"
                        : PanelService.Instance.ActiveApp,
                    surface = "main",
                    appReady = false,
                    elementCount = LastGeometry?.ElementCount ?? 0,
                    totalVertices = LastGeometry?.TotalVertices ?? 0,
                    totalIndices = LastGeometry?.TotalIndices ?? 0,
                    truncated = LastGeometry?.Truncated ?? false,
                    skippedElements = LastGeometry?.SkippedElements ?? 0,
                    annotationCount = LastAnnotations?.Count ?? 0,
                    lastPick = LastPickElementId,
                    lastPickAtUtc = LastPickAtUtc,
                    lastError = LastError,
                    report = LastReport == null ? null : new
                    {
                        title = LastReport.Value<string>("title"),
                        kind = LastReport.Value<string>("kind") ?? LastReport.Value<string>("type"),
                        hasContent = true,
                    },
                    pendingAgentInstruction = string.IsNullOrEmpty(PendingAgentInstruction) ? null : new
                    {
                        text = PendingAgentInstruction,
                        source = PendingAgentInstructionSource,
                        atUtc = PendingAgentInstructionAtUtc,
                        hint = "Call panel_get_agent_instruction to claim and clear this text, then follow it.",
                    },
                    lastUserCapture = _lastUserCapture == null ? null : new
                    {
                        ok = _lastUserCapture.Ok,
                        atUtc = _lastUserCaptureAtUtc,
                        mimeType = _lastUserCapture.MimeType,
                        width = _lastUserCapture.Width,
                        height = _lastUserCapture.Height,
                        byteLength = _lastUserCapture.ByteLength,
                        fileName = _lastUserCaptureFileName,
                        filePath = _lastUserCaptureFilePath,
                        elementCount = _lastUserCapture.ElementCount,
                    },
                };
            }
        }

        public static object GetLastUserCapture()
        {
            lock (Sync)
            {
                if (_lastUserCapture == null || !_lastUserCapture.Ok || string.IsNullOrEmpty(_lastUserCapture.DataBase64))
                {
                    return new
                    {
                        ok = false,
                        error = "no_user_capture",
                        message = "No user capture yet. Click Send capture in the Agent Canvas HUD first.",
                    };
                }

                return new
                {
                    ok = true,
                    source = "user",
                    capturedAtUtc = _lastUserCaptureAtUtc,
                    mimeType = _lastUserCapture.MimeType,
                    width = _lastUserCapture.Width,
                    height = _lastUserCapture.Height,
                    byteLength = _lastUserCapture.ByteLength,
                    dataBase64 = _lastUserCapture.DataBase64,
                    fileName = _lastUserCaptureFileName,
                    filePath = _lastUserCaptureFilePath,
                    elementCount = _lastUserCapture.ElementCount,
                    totalVertices = _lastUserCapture.TotalVertices,
                    camera = _lastUserCapture.Camera,
                };
            }
        }

        public static void ClearError() => LastError = null;

        public static void SetError(string error) => LastError = error;

        public static void SetPendingAgentInstruction(string text, string source)
        {
            lock (Sync)
            {
                PendingAgentInstruction = string.IsNullOrWhiteSpace(text) ? null : text.Trim();
                PendingAgentInstructionSource = string.IsNullOrWhiteSpace(source) ? null : source.Trim();
                PendingAgentInstructionAtUtc = string.IsNullOrEmpty(PendingAgentInstruction)
                    ? (DateTime?)null
                    : DateTime.UtcNow;
            }

            if (!string.IsNullOrEmpty(PendingAgentInstruction))
            {
                PanelService.Instance.WritePanelLog(
                    "agent_instruction queued source=" + (PendingAgentInstructionSource ?? "?")
                    + " chars=" + PendingAgentInstruction.Length);
            }
        }

        public static object ClaimPendingAgentInstruction(bool clear = true)
        {
            lock (Sync)
            {
                if (string.IsNullOrEmpty(PendingAgentInstruction))
                {
                    return new
                    {
                        ok = true,
                        empty = true,
                        message = "No pending agent instruction. Click Run in the GBP Audit (or Schedule) tab first.",
                    };
                }

                var result = new
                {
                    ok = true,
                    empty = false,
                    text = PendingAgentInstruction,
                    source = PendingAgentInstructionSource,
                    atUtc = PendingAgentInstructionAtUtc,
                    cleared = clear,
                };

                if (clear)
                {
                    PendingAgentInstruction = null;
                    PendingAgentInstructionSource = null;
                    PendingAgentInstructionAtUtc = null;
                    PostToJs("agent_instruction_cleared", new { ok = true });
                }

                return result;
            }
        }

        public static void HandleJsMessage(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                return;

            Newtonsoft.Json.Linq.JObject message;
            try { message = Newtonsoft.Json.Linq.JObject.Parse(json); }
            catch (Exception ex)
            {
                SetError("invalid_js_message: " + ex.Message);
                return;
            }

            string type = message.Value<string>("type");
            if (string.IsNullOrWhiteSpace(type))
                return;

            var payload = message["payload"] as Newtonsoft.Json.Linq.JObject
                ?? message; // tolerate flat messages from older pages

            switch (type.ToLowerInvariant())
            {
                case "ready":
                    PanelService.Instance.WritePanelLog("panel_js_ready");
                    ClearError();
                    break;
                case "log":
                    PanelService.Instance.WritePanelLog("panel_js_log: " + payload?.ToString(Newtonsoft.Json.Formatting.None));
                    break;
                case "error":
                    string error = payload?.Value<string>("message") ?? payload?.ToString(Newtonsoft.Json.Formatting.None);
                    SetError(error);
                    PanelService.Instance.WritePanelLog("panel_js_error: " + error);
                    break;
                case "pick":
                    long elementId = payload?.Value<long?>("elementId") ?? message.Value<long?>("elementId") ?? 0;
                    if (elementId > 0)
                        QueuePick(elementId);
                    break;
                case "request_geometry":
                    PanelService.Instance.WritePanelLog("panel_js_request_geometry");
                    LoadGeometryExternalEvent.Request();
                    break;
                case "user_capture":
                    StoreUserCapture(payload ?? message);
                    break;
                case "capture_result":
                    CompleteCapture(payload ?? message);
                    break;
                case "view_changed":
                    {
                        string view = (payload?.Value<string>("view") ?? message.Value<string>("view") ?? "model")
                            .Trim()
                            .ToLowerInvariant();
                        ActiveView = view == "report" ? "report" : "model";
                        if (view == "model" || view == "report")
                            PanelService.Instance.SetSurface(view);
                        PanelService.Instance.WritePanelLog("panel_view=" + ActiveView);
                    }
                    break;
                case "app_tools_call":
                    {
                        string requestId = payload?.Value<string>("requestId") ?? message.Value<string>("requestId");
                        string toolName = payload?.Value<string>("name") ?? message.Value<string>("name");
                        JObject args = payload?["arguments"] as JObject
                            ?? message["arguments"] as JObject
                            ?? new JObject();
                        ThreadPool.QueueUserWorkItem(_ =>
                        {
                            try
                            {
                                object result = PanelAppToolRouter.Invoke(toolName, args);
                                PostToJs("app_tools_result", new { requestId, ok = true, result });
                            }
                            catch (Exception ex)
                            {
                                PostToJs("app_tools_result", new { requestId, ok = false, error = ex.Message });
                            }
                        });
                    }
                    break;
                case "agent_instruction":
                    {
                        string text = payload?.Value<string>("text") ?? message.Value<string>("text");
                        string source = payload?.Value<string>("source") ?? message.Value<string>("source");
                        SetPendingAgentInstruction(text, source);
                    }
                    break;
                default:
                    PanelService.Instance.WritePanelLog("panel_js_unknown_type: " + type);
                    break;
            }
        }

        private static PanelCaptureResult ParseCapturePayload(JObject payload)
        {
            bool ok = payload.Value<bool?>("ok") ?? (!string.IsNullOrEmpty(payload.Value<string>("dataBase64")));
            return new PanelCaptureResult
            {
                Ok = ok,
                Error = payload.Value<string>("error"),
                Message = payload.Value<string>("message"),
                MimeType = payload.Value<string>("mimeType") ?? "image/png",
                Width = payload.Value<int?>("width") ?? 0,
                Height = payload.Value<int?>("height") ?? 0,
                ByteLength = payload.Value<int?>("byteLength") ?? 0,
                DataBase64 = payload.Value<string>("dataBase64"),
                ElementCount = payload.Value<int?>("elementCount") ?? 0,
                TotalVertices = payload.Value<int?>("totalVertices") ?? 0,
                Camera = payload["camera"],
            };
        }

        private static void StoreUserCapture(JObject payload)
        {
            if (payload == null)
                return;

            var capture = ParseCapturePayload(payload);
            string fileName = null;
            string filePath = null;

            if (capture.Ok && !string.IsNullOrEmpty(capture.DataBase64))
            {
                try
                {
                    string folder = PanelService.Instance.PanelTmpFolder;
                    Directory.CreateDirectory(folder);
                    string ext = string.Equals(capture.MimeType, "image/jpeg", StringComparison.OrdinalIgnoreCase)
                        ? "jpg"
                        : "png";
                    fileName = "user_capture_" + Guid.NewGuid().ToString("N") + "." + ext;
                    filePath = Path.Combine(folder, fileName);
                    File.WriteAllBytes(filePath, Convert.FromBase64String(capture.DataBase64));
                    PanelService.Instance.WritePanelLog(
                        $"panel_user_capture saved {fileName} {capture.Width}x{capture.Height}");
                }
                catch (Exception ex)
                {
                    PanelService.Instance.WritePanelLog("panel_user_capture_save_failed: " + ex.Message);
                }
            }
            else
            {
                PanelService.Instance.WritePanelLog(
                    "panel_user_capture_failed: " + (capture.Message ?? capture.Error ?? "unknown"));
            }

            lock (Sync)
            {
                _lastUserCapture = capture;
                _lastUserCaptureAtUtc = DateTime.UtcNow;
                _lastUserCaptureFileName = fileName;
                _lastUserCaptureFilePath = filePath;
            }
        }

        private static void CompleteCapture(JObject payload)
        {
            if (payload == null)
                return;

            string requestId = payload.Value<string>("requestId");
            lock (Sync)
            {
                if (!string.IsNullOrEmpty(_pendingCaptureRequestId)
                    && !string.IsNullOrEmpty(requestId)
                    && !string.Equals(_pendingCaptureRequestId, requestId, StringComparison.Ordinal))
                {
                    PanelService.Instance.WritePanelLog(
                        "panel_capture_ignored stale requestId=" + requestId);
                    return;
                }

                _pendingCaptureResult = ParseCapturePayload(payload);
            }

            CaptureGate.Set();
        }

        public static bool TryDequeuePick(out long elementId)
        {
            lock (Sync)
            {
                if (_pendingPick == null)
                {
                    elementId = 0;
                    return false;
                }

                elementId = _pendingPick.ElementId;
                _pendingPick = null;
                return true;
            }
        }

        public static void CompletePick(long elementId)
        {
            LastPickElementId = elementId;
            LastPickAtUtc = DateTime.UtcNow;
            PanelService.Instance.WritePanelLog("panel_pick elementId=" + elementId);
        }

        public static void CompletePickError(string error)
        {
            SetError(error);
            PanelService.Instance.WritePanelLog("panel_pick_failed: " + error);
        }

        private static void QueuePick(long elementId)
        {
            lock (Sync)
            {
                _pendingPick = new PickRequest { ElementId = elementId };
            }

            PickExternalEvent.Request();
        }

        private sealed class PickRequest
        {
            public long ElementId { get; set; }
        }

        private sealed class PanelCaptureResult
        {
            public bool Ok { get; set; }
            public string Error { get; set; }
            public string Message { get; set; }
            public string MimeType { get; set; }
            public int Width { get; set; }
            public int Height { get; set; }
            public int ByteLength { get; set; }
            public string DataBase64 { get; set; }
            public int ElementCount { get; set; }
            public int TotalVertices { get; set; }
            public JToken Camera { get; set; }
        }
    }
}
