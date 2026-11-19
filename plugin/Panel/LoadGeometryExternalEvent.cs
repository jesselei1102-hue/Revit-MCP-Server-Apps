using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// User-triggered load: extract the active Revit view's model geometry into the Agent Canvas.
    /// Raised from the panel HUD button (no MCP round-trip).
    /// </summary>
    internal sealed class LoadGeometryExternalEvent : IExternalEventHandler
    {
        private static readonly LoadGeometryExternalEvent Handler = new();
        private static ExternalEvent _event;
        private static readonly object Sync = new();
        private static bool _pending;

        private LoadGeometryExternalEvent() { }

        public static void Register()
        {
            lock (Sync)
            {
                _event ??= ExternalEvent.Create(Handler);
            }
        }

        public static void Request()
        {
            lock (Sync)
            {
                _pending = true;
            }

            if (_event == null)
            {
                PanelBridge.SetError("load_geometry_event_not_registered");
                PanelBridge.PostToJs("load_geometry_result", new
                {
                    ok = false,
                    error = "load_geometry_event_not_registered",
                    message = "Panel load event was not registered. Toggle MCP Off/On and retry.",
                });
                return;
            }

            _event.Raise();
        }

        public void Execute(UIApplication app)
        {
            bool run;
            lock (Sync)
            {
                run = _pending;
                _pending = false;
            }

            if (!run)
                return;

            try
            {
                UIDocument uiDoc = app?.ActiveUIDocument
                    ?? throw new InvalidOperationException("No active document");
                Document doc = uiDoc.Document;
                View view = doc.ActiveView
                    ?? throw new InvalidOperationException("No active view");

                PanelBridge.PostToJs("load_geometry_progress", new { message = "extracting…" });

                IList<Element> targets = PanelMeshExtractor.ResolveTargets(doc, view, null);
                PanelMeshResult extraction = PanelMeshExtractor.Extract(doc, targets);
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
                    $"panel_user_load_geometry view={view.Name} elements={summary.ElementCount} verts={summary.TotalVertices}");
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
        }

        public string GetName() => "MCP Agent Canvas load geometry";
    }
}
