using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// User-triggered load. The Revit API cannot run in another process, so a full conversion
    /// is pumped in short slices on Revit's thread and then written to disk off that thread.
    /// Between slices Revit paints, takes mouse and keyboard input, and stays usable.
    /// </summary>
    internal sealed class LoadGeometryExternalEvent : IExternalEventHandler
    {
        const int SliceMs = 80;

        private static readonly LoadGeometryExternalEvent Handler = new();
        private static ExternalEvent _event;
        private static readonly object Sync = new();
        private static bool _pending;
        private static bool _busy;
        private static bool _inSlice;
        private static bool _awaitResolve;
        private static UIApplication _uiApp;
        private static UIControlledApplication _uiControlled;
        private static PanelMeshExtractor.ExtractSession _session;
        private static LoadContext _context;
        private static SaveRequest _save;

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
            bool saving;
            bool resolve;
            lock (Sync)
            {
                saving = _save != null && !_save.Ready;
                resolve = _awaitResolve;
            }

            // Keep the idle loop turning while the file is written on another thread,
            // so the canvas is told as soon as the file is ready.
            if (saving || resolve)
                e.SetRaiseWithoutDelay();

            if (resolve)
            {
                lock (Sync)
                {
                    _awaitResolve = false;
                    _inSlice = true;
                }

                try { Start(_uiApp); }
                catch (Exception ex) { Abort(ex); }
                finally
                {
                    lock (Sync) { _inSlice = false; }
                }

                return;
            }

            if (TryPublishSave())
                return;

            if (Pump(e))
                return;

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
            if (TryPublishSave())
                return;

            bool idleDriven;
            lock (Sync)
            {
                if (_session != null || _save != null || _awaitResolve)
                    return;
                if (!_pending || _busy)
                    return;
                _pending = false;
                _busy = true;
                _uiApp = app;
                idleDriven = _uiControlled != null;
                _awaitResolve = idleDriven;
            }

            if (!idleDriven)
            {
                Start(app);
                return;
            }

            // Return immediately so the canvas can show this before element collection starts.
            PostProgress("Finding elements in the active view…", 0, 0, 0);
        }

        static void Start(UIApplication app)
        {
            bool keepBusy = false;
            try
            {
                UIDocument uiDoc = app?.ActiveUIDocument
                    ?? throw new InvalidOperationException("No active document");
                Document doc = uiDoc.Document;
                View view = doc.ActiveView
                    ?? throw new InvalidOperationException("No active view");

                IList<Element> targets = PanelMeshExtractor.ResolveTargets(doc, view, null);
                string tmpDir = PanelService.Instance.PanelTmpFolder;
                string stableId = PanelViewMeshCache.StableId(doc, view);
                string cacheKey = PanelViewMeshCache.Fingerprint(doc, view, targets);
                string modelFile = PanelViewMeshCache.FileNameFor(stableId);
                if (PanelViewMeshCache.TryUse(tmpDir, stableId, cacheKey, out PanelGeometrySummary cached))
                {
                    PanelBridge.ClearError();
                    PanelBridge.SetActiveDocument(doc);
                    PanelBridge.PostToJs("load_geometry_progress", new { message = "Opening the saved model", percent = 100, done = 1, total = 1 });
                    PanelBridge.PostGeometryReady(cached);
                    PanelBridge.PostToJs("load_geometry_result", new
                    {
                        ok = true,
                        viewName = view.Name,
                        elementCount = cached.ElementCount,
                        totalVertices = cached.TotalVertices,
                        truncated = cached.Truncated,
                        skippedElements = cached.SkippedElements,
                        cached = true,
                        scope = "Opened the saved model. Filter and later views use this file.",
                    });
                    PanelService.Instance.WritePanelLog(
                        $"panel_user_load_geometry model cache hit view={view.Name} file={modelFile} elements={cached.ElementCount}");
                    return;
                }

                int modelVersion = PanelViewMeshCache.NextVersion(tmpDir, stableId);
                var progressClock = System.Diagnostics.Stopwatch.StartNew();
                long lastProgressMs = -1000;
                var extractOptions = new PanelMeshExtractor.ExtractOptions
                {
                    SkipLinks = false,
                    MaxElapsedMs = PanelMeshExtractor.DefaultMaxElapsedMs,
                    View = view,
                    Progress = (done, total, label) =>
                    {
                        if (progressClock.ElapsedMilliseconds - lastProgressMs < 350 && done < total)
                            return;
                        lastProgressMs = progressClock.ElapsedMilliseconds;
                        PostProgress(string.IsNullOrWhiteSpace(label) ? "Converting…" : label, done, total, Percent(done, total));
                    },
                };

                PostProgress("Converting in the background. You can keep using Revit.", 0, targets.Count, 0);
                _context = new LoadContext
                {
                    Doc = doc,
                    ViewName = view.Name ?? string.Empty,
                    TmpDir = tmpDir,
                    ModelFile = modelFile,
                    CacheKey = cacheKey,
                    ModelVersion = modelVersion,
                    Source = doc.PathName ?? doc.Title ?? string.Empty,
                };
                _session = PanelMeshExtractor.StartSession(doc, targets, extractOptions);

                if (_uiControlled == null)
                {
                    _session.Drain();
                    SaveOnThisThread();
                    return;
                }

                if (!_session.Step(SliceMs))
                    BeginSave();
                keepBusy = _session != null || _save != null;
            }
            catch (Exception ex)
            {
                Abort(ex);
                keepBusy = false;
            }
            finally
            {
                lock (Sync)
                {
                    if (!keepBusy && _save == null)
                        _busy = false;
                }
            }
        }

        static bool Pump(Autodesk.Revit.UI.Events.IdlingEventArgs e)
        {
            PanelMeshExtractor.ExtractSession session;
            lock (Sync)
            {
                if (_session == null || _inSlice || _save != null)
                    return false;
                session = _session;
                _inSlice = true;
            }

            // Ask Revit for another idle immediately so the conversion continues
            // without a mouse move, but this handler still returns to the message pump.
            e.SetRaiseWithoutDelay();
            try
            {
                if (!session.IsDocumentValid)
                    throw new InvalidOperationException("The document closed during conversion.");
                if (!session.Step(SliceMs))
                    BeginSave();
            }
            catch (Exception ex)
            {
                Abort(ex);
            }
            finally
            {
                lock (Sync)
                {
                    _inSlice = false;
                }
            }

            return true;
        }

        static void BeginSave()
        {
            PanelMeshExtractor.ExtractSession session;
            LoadContext ctx;
            lock (Sync)
            {
                session = _session;
                ctx = _context;
                _session = null;
            }

            if (session == null || ctx == null)
            {
                lock (Sync) { _busy = false; }
                return;
            }

            PanelMeshResult extraction = session.Result;
            session.Dispose();
            if (extraction.Elements.Count == 0)
            {
                lock (Sync)
                {
                    _context = null;
                    _busy = false;
                }

                PanelBridge.SetError("no_geometry");
                PanelBridge.PostToJs("load_geometry_result", new
                {
                    ok = false,
                    error = "no_geometry",
                    message = "No extractable geometry in the active view.",
                    viewName = ctx.ViewName,
                    skippedElements = extraction.SkippedElements,
                    truncated = extraction.Truncated,
                });
                return;
            }

            try { PanelBridge.SetActiveDocument(ctx.Doc); }
            catch (Exception) { /* the mesh is already in memory */ }

            var cache = new Newtonsoft.Json.Linq.JObject
            {
                ["schema"] = 1,
                ["version"] = ctx.ModelVersion,
                ["fingerprint"] = ctx.CacheKey,
                ["savedAt"] = DateTime.UtcNow.ToString("o"),
                ["source"] = ctx.Source,
                ["view"] = ctx.ViewName,
                ["elementCount"] = extraction.Elements.Count,
                ["totalVertices"] = extraction.TotalVertices,
                ["totalIndices"] = extraction.TotalIndices,
                ["truncated"] = extraction.Truncated,
                ["skippedElements"] = extraction.SkippedElements,
            };
            var save = new SaveRequest
            {
                TmpDir = ctx.TmpDir,
                ModelFile = ctx.ModelFile,
                ViewName = ctx.ViewName,
                Extraction = extraction,
                Cache = cache,
            };
            lock (Sync) { _save = save; }

            PostProgress("Saving the model file", extraction.Elements.Count, extraction.Elements.Count, 99);
            Task.Run(() =>
            {
                try
                {
                    save.Summary = PanelMeshPayloadWriter.WriteModel(save.TmpDir, save.ModelFile, save.Extraction, save.Cache);
                }
                catch (Exception ex)
                {
                    save.Error = ex;
                }

                lock (Sync) { save.Ready = true; }
                try { _event?.Raise(); }
                catch (Exception ex)
                {
                    PanelService.Instance.WritePanelLog("load_geometry_save_raise_failed: " + ex.Message);
                }
            });
        }

        static void SaveOnThisThread()
        {
            BeginSave();
            // No Idling subscriber: finish the file here instead of leaving it on the thread pool.
            SaveRequest save;
            lock (Sync) { save = _save; }
            if (save == null)
                return;
            while (!save.Ready)
                System.Threading.Thread.Sleep(20);
            TryPublishSave();
        }

        static bool TryPublishSave()
        {
            SaveRequest save;
            lock (Sync)
            {
                if (_save == null)
                    return false;
                if (!_save.Ready)
                    return true;
                save = _save;
                _save = null;
                _context = null;
                _busy = false;
            }

            if (save.Error != null)
            {
                PanelBridge.SetError(save.Error.Message);
                PanelBridge.PostToJs("load_geometry_result", new
                {
                    ok = false,
                    error = "load_geometry_failed",
                    message = save.Error.Message,
                });
                PanelService.Instance.WritePanelLog("panel_user_load_geometry_failed: " + save.Error.Message);
                return true;
            }

            PanelGeometrySummary summary = save.Summary;
            PanelBridge.ClearError();
            PanelBridge.PostGeometryReady(summary);
            string scope = "Active view model categories + Rooms/Spaces; linked models included (shell prioritized). Planting/Entourage skipped. Conversion runs in the background, so Revit stays usable.";
            PanelBridge.PostToJs("load_geometry_result", new
            {
                ok = true,
                viewName = save.ViewName,
                elementCount = summary.ElementCount,
                totalVertices = summary.TotalVertices,
                truncated = summary.Truncated,
                skippedElements = summary.SkippedElements,
                scope,
            });
            PanelService.Instance.WritePanelLog(
                $"panel_user_load_geometry view={save.ViewName} elements={summary.ElementCount} verts={summary.TotalVertices} truncated={summary.Truncated}");
            return true;
        }

        static void Abort(Exception ex)
        {
            lock (Sync)
            {
                try { _session?.Dispose(); } catch (Exception) { /* already gone */ }
                _session = null;
                _context = null;
                _save = null;
                _awaitResolve = false;
                _busy = false;
                _pending = false;
            }

            PanelBridge.SetError(ex.Message);
            PanelBridge.PostToJs("load_geometry_result", new
            {
                ok = false,
                error = "load_geometry_failed",
                message = ex.Message,
            });
            PanelService.Instance.WritePanelLog("panel_user_load_geometry_failed: " + ex.Message);
        }

        static void PostProgress(string message, int done, int total, int percent)
        {
            PanelBridge.PostToJs("load_geometry_progress", new
            {
                message,
                percent,
                done,
                total,
                background = true,
            });
        }

        static int Percent(int done, int total)
        {
            if (total <= 0)
                return 0;
            return (int)Math.Min(99, done * 100L / total);
        }

        public string GetName() => "MCP Agent Canvas load geometry";

        sealed class LoadContext
        {
            public Document Doc;
            public string ViewName;
            public string TmpDir;
            public string ModelFile;
            public string CacheKey;
            public int ModelVersion;
            public string Source;
        }

        sealed class SaveRequest
        {
            public string TmpDir;
            public string ModelFile;
            public string ViewName;
            public PanelMeshResult Extraction;
            public Newtonsoft.Json.Linq.JObject Cache;
            public PanelGeometrySummary Summary;
            public Exception Error;
            public bool Ready;
        }
    }
}
