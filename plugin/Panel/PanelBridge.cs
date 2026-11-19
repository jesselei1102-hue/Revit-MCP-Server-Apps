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
        public static long? LastPickElementId { get; private set; }
        public static DateTime? LastPickAtUtc { get; private set; }
        public static string LastError { get; private set; }
        public static string LastGeometryToken { get; private set; }

        // Source document of the currently loaded mesh, recorded at extraction time.
        // Used by PanelDocumentSync to ignore DocumentChanged events for other open documents.
        public static string ActiveDocumentPath { get; private set; }
        public static string ActiveDocumentToken { get; private set; }
        private static PickRequest _pendingPick;
        private static readonly ManualResetEventSlim CaptureGate = new(false);
        private static string _pendingCaptureRequestId;
        private static PanelCaptureResult _pendingCaptureResult;

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

        public static void PostSetAnalysis(IList<PanelAnalysisItem> items)
        {
            LastAnalysis = items != null ? new List<PanelAnalysisItem>(items) : new List<PanelAnalysisItem>();
            PostToJs("set_analysis", new { items = LastAnalysis });
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
            }

            PostToJs("clear", new { target = target ?? "all" });
        }

        public static void PostFit()
        {
            PostToJs("fit", new { });
        }

        /// <summary>
        /// Ask the WebView to snapshot the current Three.js frame and wait for the result.
        /// Must be called from a non-UI thread (socket command thread) so the WebView
        /// message callback can run on the UI thread without deadlock.
        /// </summary>
        public static object Capture(JObject parameters, int timeoutMilliseconds = 20000)
        {
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
                    view = "model",
                    elementCount = LastGeometry?.ElementCount ?? 0,
                    totalVertices = LastGeometry?.TotalVertices ?? 0,
                    totalIndices = LastGeometry?.TotalIndices ?? 0,
                    truncated = LastGeometry?.Truncated ?? false,
                    skippedElements = LastGeometry?.SkippedElements ?? 0,
                    lastPick = LastPickElementId,
                    lastPickAtUtc = LastPickAtUtc,
                    lastError = LastError,
                };
            }
        }

        public static void ClearError() => LastError = null;

        public static void SetError(string error) => LastError = error;

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
                case "capture_result":
                    CompleteCapture(payload ?? message);
                    break;
                default:
                    PanelService.Instance.WritePanelLog("panel_js_unknown_type: " + type);
                    break;
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

                bool ok = payload.Value<bool?>("ok") ?? false;
                _pendingCaptureResult = new PanelCaptureResult
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
