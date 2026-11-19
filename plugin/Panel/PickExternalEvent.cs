using System;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Runs the element selection for a JS pick on the Revit UI thread.
    /// </summary>
    internal sealed class PickExternalEvent : IExternalEventHandler
    {
        private static readonly PickExternalEvent Handler = new();
        private static ExternalEvent _event;
        private static readonly object Sync = new();

        private PickExternalEvent() { }

        /// <summary>
        /// Must be called from a standard Revit API execution context (e.g. SocketService.Initialize).
        /// </summary>
        public static void Register()
        {
            lock (Sync)
            {
                _event ??= ExternalEvent.Create(Handler);
            }
        }

        public static void Request()
        {
            if (_event == null)
            {
                // Should not happen after Register(); keep the panel alive but report it.
                PanelBridge.CompletePickError("pick_event_not_registered");
                return;
            }

            _event.Raise();
        }

        public void Execute(UIApplication app)
        {
            while (PanelBridge.TryDequeuePick(out long elementId))
            {
                try
                {
                    UIDocument uiDoc = app?.ActiveUIDocument
                        ?? throw new InvalidOperationException("No active document");

                    uiDoc.Selection.SetElementIds(new System.Collections.Generic.List<Autodesk.Revit.DB.ElementId>
                    {
                        PanelElementIds.Create(elementId),
                    });

                    PanelBridge.CompletePick(elementId);
                }
                catch (Exception ex)
                {
                    PanelBridge.CompletePickError(ex.Message);
                }
            }
        }

        public string GetName() => "MCP Agent Canvas pick";
    }
}
