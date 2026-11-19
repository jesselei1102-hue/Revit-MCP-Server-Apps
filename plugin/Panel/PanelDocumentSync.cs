using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Keeps the Agent Canvas 3D view in sync with the Revit model while it is loaded.
    /// Fires on DocumentChanged (after the transaction has been committed), coalesces the
    /// added / modified / deleted element ids, and defers the actual work to an
    /// ExternalEvent on the Revit UI thread.
    ///
    /// Deleted ids need no geometry; the delta file (if any) only carries re-extracted
    /// added/modified elements, so the panel can merge in-place without a full reload.
    /// </summary>
    internal static class PanelDocumentSync
    {
        private static UIControlledApplication _controlledApp;

        /// <summary>
        /// Subscribe to the application-wide DocumentChanged event. Must be called from
        /// IExternalApplication.OnStartup (standard Revit API context).
        /// </summary>
        public static void Initialize(UIControlledApplication application)
        {
            if (application == null)
                throw new ArgumentNullException(nameof(application));

            if (_controlledApp != null)
                return; // already subscribed

            _controlledApp = application;
            // ExternalEvent.Create must happen inside a standard Revit API execution context.
            PanelDeltaSyncEventHandler.Register();
            application.ControlledApplication.DocumentChanged += OnDocumentChanged;
        }

        public static void Shutdown()
        {
            if (_controlledApp == null)
                return;

            try
            {
                _controlledApp.ControlledApplication.DocumentChanged -= OnDocumentChanged;
            }
            catch
            {
                // best effort; Revit is shutting down anyway
            }

            _controlledApp = null;
        }

        private static void OnDocumentChanged(object sender, DocumentChangedEventArgs e)
        {
            try
            {
                // Only sync when the panel actually has a model loaded.
                if (PanelBridge.LastGeometry == null)
                    return;

                Document changedDoc = e.GetDocument();
                if (changedDoc == null)
                    return;

                // The event fires for every open document, including linked docs.
                // Only the document the panel mesh was extracted from is of interest.
                if (!IsSourceDocument(changedDoc))
                    return;

                ICollection<ElementId> deletedIds = e.GetDeletedElementIds();
                ICollection<ElementId> addedIds = e.GetAddedElementIds();
                ICollection<ElementId> modifiedIds = e.GetModifiedElementIds();

                var deleted = new List<long>();
                var upsert = new List<long>();

                foreach (ElementId id in deletedIds)
                {
                    if (id != null && id.Value > 0)
                        deleted.Add(id.Value);
                }

                foreach (ElementId id in addedIds)
                {
                    if (id != null && id.Value > 0)
                        upsert.Add(id.Value);
                }

                foreach (ElementId id in modifiedIds)
                {
                    if (id != null && id.Value > 0)
                        upsert.Add(id.Value);
                }

                if (deleted.Count == 0 && upsert.Count == 0)
                    return;

                PanelDeltaSyncEventHandler.Queue(deleted, upsert);
            }
            catch (Exception ex)
            {
                PanelService.Instance.WritePanelLog("document_changed_sync_failed: " + ex);
            }
        }

        private static bool IsSourceDocument(Document changedDoc)
        {
            if (changedDoc == null)
                return false;

            string sourcePath = PanelBridge.ActiveDocumentPath;
            if (!string.IsNullOrEmpty(sourcePath))
            {
                string changedPath;
                try { changedPath = changedDoc.PathName; }
                catch { changedPath = null; }
                if (!string.IsNullOrEmpty(changedPath))
                    return string.Equals(changedPath, sourcePath, StringComparison.OrdinalIgnoreCase);
            }

            string sourceToken = PanelBridge.ActiveDocumentToken;
            if (!string.IsNullOrEmpty(sourceToken))
            {
                string changedToken;
                try { changedToken = changedDoc.Title; }
                catch { changedToken = null; }
                return string.Equals(changedToken, sourceToken, StringComparison.Ordinal);
            }

            return false;
        }
    }

    /// <summary>
    /// Coalesces queued changes from one or more DocumentChanged firings and applies them
    /// on the Revit UI thread via the ExternalEvent pattern.
    /// </summary>
    internal sealed class PanelDeltaSyncEventHandler : IExternalEventHandler
    {
        private static readonly PanelDeltaSyncEventHandler Handler = new();
        private static ExternalEvent _event;
        private readonly object _sync = new();
        private readonly HashSet<long> _pendingDeleted = new();
        private readonly HashSet<long> _pendingUpsert = new();

        private PanelDeltaSyncEventHandler() { }

        public static void Register()
        {
            if (_event == null)
                _event = ExternalEvent.Create(Handler);
        }

        public static void Queue(IList<long> deleted, IList<long> upsert)
        {
            if (_event == null)
                return;

            lock (Handler._sync)
            {
                if (deleted != null)
                    foreach (long id in deleted)
                        Handler._pendingDeleted.Add(id);

                if (upsert != null)
                    foreach (long id in upsert)
                        Handler._pendingUpsert.Add(id);
            }

            _event.Raise();
        }

        public void Execute(UIApplication app)
        {
            List<long> deleted;
            List<long> upsert;

            lock (_sync)
            {
                if (_pendingDeleted.Count == 0 && _pendingUpsert.Count == 0)
                    return;

                deleted = _pendingDeleted.ToList();
                upsert = _pendingUpsert.ToList();
                _pendingDeleted.Clear();
                _pendingUpsert.Clear();
            }

            try
            {
                Document doc = app?.ActiveUIDocument?.Document;
                if (doc == null)
                    return;

                if (!IsSourceDocument(doc))
                    return;

                var upsertElements = new List<Element>();
                foreach (long id in upsert)
                {
                    Element element;
                    try { element = doc.GetElement(new ElementId(id)); }
                    catch (Exception) { element = null; }

                    if (element == null)
                        continue; // added then deleted within the same burst, or not model data

                    if (element.Category?.CategoryType != CategoryType.Model)
                        continue;

                    upsertElements.Add(element);
                }

                PanelGeometrySummary delta = null;
                if (upsertElements.Count > 0)
                {
                    PanelMeshResult extraction = PanelMeshExtractor.Extract(doc, upsertElements, new PanelMeshExtractor.ExtractOptions
                    {
                        View = doc.ActiveView,
                    });
                    if (extraction.Elements.Count > 0)
                        delta = PanelMeshPayloadWriter.WriteDelta(PanelService.Instance.PanelTmpFolder, extraction);
                }

                PanelBridge.PostGeometryDelta(deleted, upsert, delta);

                PanelService.Instance.WritePanelLog(
                    $"delta_sync deleted={deleted.Count} upsert={upsert.Count} reExtracted={delta?.ElementCount ?? 0}");
            }
            catch (Exception ex)
            {
                PanelService.Instance.WritePanelLog("delta_sync_failed: " + ex);
            }
        }

        public string GetName() => "MCP Agent Canvas delta sync";

        private static bool IsSourceDocument(Document doc)
        {
            if (doc == null)
                return false;

            string sourcePath = PanelBridge.ActiveDocumentPath;
            if (!string.IsNullOrEmpty(sourcePath))
            {
                string path;
                try { path = doc.PathName; }
                catch { path = null; }

                if (!string.IsNullOrEmpty(path))
                    return string.Equals(path, sourcePath, StringComparison.OrdinalIgnoreCase);
            }

            string sourceToken = PanelBridge.ActiveDocumentToken;
            if (!string.IsNullOrEmpty(sourceToken))
            {
                string token;
                try { token = doc.Title; }
                catch { token = null; }

                return string.Equals(token, sourceToken, StringComparison.Ordinal);
            }

            return false;
        }
    }
}
