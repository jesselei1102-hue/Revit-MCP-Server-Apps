using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// User-triggered load: extract the active Revit view's model geometry into the Agent Canvas.
    /// Raised from the panel HUD button (no MCP round-trip).
    /// Uses the same extract coverage as the agent; a time budget still protects the UI.
    /// </summary>
    internal sealed class LoadGeometryExternalEvent : IExternalEventHandler
    {
        private static readonly LoadGeometryExternalEvent Handler = new();
        private static ExternalEvent _event;
        private static readonly object Sync = new();
        private static bool _pending;
        private static bool _busy;
        private static UIControlledApplication _uiControlled;

        private LoadGeometryExternalEvent() { }

        public static void Register(UIControlledApplication application = null)
        {
            lock (Sync)
            {
                if (application != null && _uiControlled == null)
                {
                    _uiControlled = application;
                    _uiControlled.Idling += OnIdling;
                }

                _event ??= ExternalEvent.Create(Handler);
            }
        }

        public static void Request()
        {
            lock (Sync)
            {
                if (_busy)
                {
                    PanelBridge.PostToJs("load_geometry_result", new
                    {
                        ok = false,
                        error = "load_busy",
                        message = "A Load Revit view is already running. Wait for it to finish.",
                    });
                    return;
                }

                _pending = true;
            }

            if (_event == null)
            {
                PanelBridge.SetError("load_geometry_event_not_registered");
                PanelBridge.PostToJs("load_geometry_result", new
                {
                    ok = false,
                    error = "load_geometry_event_not_registered",
                    message = "Panel load event was not registered. Restart Revit and retry.",
                });
                return;
            }

            // Prefer Idling so we leave the WebView message callback before doing heavy work.
            // Raise() is also called as a fallback if Idling is unavailable.
            try { _event.Raise(); }
            catch (Exception ex)
            {
                PanelService.Instance.WritePanelLog("load_geometry_raise_failed: " + ex.Message);
            }
        }

        private static void OnIdling(object sender, Autodesk.Revit.UI.Events.IdlingEventArgs e)
        {
            bool needRaise;
            lock (Sync)
            {
                needRaise = _pending && !_busy;
            }

            if (!needRaise || _event == null)
                return;

            try { _event.Raise(); }
            catch (Exception ex)
            {
                PanelService.Instance.WritePanelLog("load_geometry_idling_raise_failed: " + ex.Message);
            }
        }

        public void Execute(UIApplication app)
        {
            lock (Sync)
            {
                if (!_pending || _busy)
                    return;
                _pending = false;
                _busy = true;
            }

            try
            {
                UIDocument uiDoc = app?.ActiveUIDocument
                    ?? throw new InvalidOperationException("No active document");
                Document doc = uiDoc.Document;
                View view = doc.ActiveView
                    ?? throw new InvalidOperationException("No active view");

                PanelBridge.PostToJs("load_geometry_progress", new { message = "extracting…" });

                IList<Element> targets = PanelMeshExtractor.ResolveTargets(doc, view, null);
                // Same coverage as agent panel_show_geometry; Options.View clips to section/scope box.
                var extractOptions = new PanelMeshExtractor.ExtractOptions
                {
                    SkipLinks = false,
                    MaxElapsedMs = PanelMeshExtractor.DefaultMaxElapsedMs,
                    View = view,
                };
                PanelMeshResult extraction = PanelMeshExtractor.Extract(doc, targets, extractOptions);
                PanelBridge.SetActiveDocument(doc);

                if (extraction.Elements.Count == 0)
                {
                    PanelBridge.SetError("no_geometry");
                    PanelBridge.PostToJs("load_geometry_result", new
                    {
                        ok = false,
                        error = "no_geometry",
                        message = "No extractable geometry in the active view.",
                        viewName = view.Name,
                        skippedElements = extraction.SkippedElements,
                        truncated = extraction.Truncated,
                    });
                    return;
                }

                PanelGeometrySummary summary = PanelMeshPayloadWriter.Write(
                    PanelService.Instance.PanelTmpFolder,
                    extraction);

                PanelBridge.ClearError();
                PanelBridge.PostGeometryReady(summary);
                PanelBridge.PostToJs("load_geometry_result", new
                {
                    ok = true,
                    viewName = view.Name,
                    elementCount = summary.ElementCount,
                    totalVertices = summary.TotalVertices,
                    truncated = summary.Truncated,
                    skippedElements = summary.SkippedElements,
                });

                PanelService.Instance.WritePanelLog(
                    $"panel_user_load_geometry view={view.Name} elements={summary.ElementCount} verts={summary.TotalVertices} truncated={summary.Truncated}");
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                PanelBridge.PostToJs("load_geometry_result", new
                {
                    ok = false,
                    error = "load_geometry_failed",
                    message = ex.Message,
                });
                PanelService.Instance.WritePanelLog("panel_user_load_geometry_failed: " + ex.Message);
            }
            finally
            {
                lock (Sync)
                {
                    _busy = false;
                }
            }
        }

        public string GetName() => "MCP Agent Canvas load geometry";
    }
}
