using System;
using System.Collections.Generic;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// In-process implementation behind <c>panel_show_geometry</c>. Runs on the Revit UI thread.
    /// </summary>
    internal class PanelShowGeometryEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);
        private List<long> _elementIds;
        private bool _selectedOnly;

        public object Result { get; private set; }

        public void SetParameters(JArray elementIds, bool selectedOnly)
        {
            _elementIds = new List<long>();
            if (elementIds != null)
            {
                foreach (JToken token in elementIds)
                {
                    if (token.Type == JTokenType.Integer && token.Value<long>() > 0)
                        _elementIds.Add(token.Value<long>());
                    else if (long.TryParse(token.ToString(), out long parsed) && parsed > 0)
                        _elementIds.Add(parsed);
                }
            }

            _selectedOnly = selectedOnly;
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                // Make sure the dockable Agent Canvas is visible before posting meshes.
                PanelService.Instance.Show(app);

                UIDocument uiDoc = app.ActiveUIDocument
                    ?? throw new InvalidOperationException("No active document");
                Document doc = uiDoc.Document;

                List<long> ids = _elementIds ?? new List<long>();
                if (ids.Count == 0 && _selectedOnly)
                {
                    foreach (ElementId id in uiDoc.Selection.GetElementIds())
                    {
                        long value = id == null ? 0 : PanelElementIds.GetValue(id);
                        if (value > 0)
                            ids.Add(value);
                    }
                }

                View view = doc.ActiveView;
                IList<Element> targets = PanelMeshExtractor.ResolveTargets(
                    doc,
                    view,
                    ids.Count > 0 ? ids : null);

                PanelMeshResult extraction = PanelMeshExtractor.Extract(doc, targets, new PanelMeshExtractor.ExtractOptions
                {
                    View = view,
                });
                PanelBridge.SetActiveDocument(doc);

                if (extraction.Elements.Count == 0)
                {
                    Result = new
                    {
                        ok = false,
                        error = "no_geometry",
                        message = "No extractable geometry found for the requested elements.",
                        elementCount = 0,
                        totalVertices = 0,
                        totalIndices = 0,
                        truncated = extraction.Truncated,
                        skippedElements = extraction.SkippedElements,
                    };
                    return;
                }

                PanelGeometrySummary summary = PanelMeshPayloadWriter.Write(
                    PanelService.Instance.PanelTmpFolder,
                    extraction);

                PanelBridge.ClearError();
                PanelBridge.PostGeometryReady(summary);

                bool sectionBoxActive = false;
                try
                {
                    if (view is View3D v3d)
                        sectionBoxActive = v3d.IsSectionBoxActive;
                }
                catch (Exception) { sectionBoxActive = false; }

                Result = new
                {
                    ok = true,
                    elementCount = summary.ElementCount,
                    totalVertices = summary.TotalVertices,
                    totalIndices = summary.TotalIndices,
                    truncated = summary.Truncated,
                    skippedElements = summary.SkippedElements,
                    viewName = view?.Name,
                    sectionBoxActive,
                };
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_show_geometry_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas show geometry";
    }

    internal class PanelSetAnalysisEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);
        private List<PanelAnalysisItem> _items = new();
        private double? _defaultOpacity;
        private bool _setDefaultOpacity;

        public object Result { get; private set; }

        public void SetItems(IList<PanelAnalysisItem> items, double? defaultOpacity = null, bool setDefaultOpacity = false)
        {
            _items = items != null ? new List<PanelAnalysisItem>(items) : new List<PanelAnalysisItem>();
            _defaultOpacity = defaultOpacity;
            _setDefaultOpacity = setDefaultOpacity;
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                PanelBridge.PostSetAnalysis(_items, _defaultOpacity, _setDefaultOpacity);
                Result = new
                {
                    ok = true,
                    applied = _items.Count,
                    defaultOpacity = _setDefaultOpacity ? _defaultOpacity : PanelBridge.LastAnalysisDefaultOpacity,
                };
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_set_analysis_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas set analysis";
    }

    internal class PanelSetAnnotationsEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);
        private JArray _items = new();

        public object Result { get; private set; }

        public void SetItems(JArray items)
        {
            _items = items != null ? (JArray)items.DeepClone() : new JArray();
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                PanelService.Instance.Show(app);
                PanelBridge.PostSetView("model");
                PanelBridge.PostSetAnnotations(_items);
                Result = new { ok = true, applied = _items.Count, view = "model" };
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_set_annotations_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas set annotations";
    }

    internal class PanelShowReportEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);
        private JObject _report;
        private bool _switchView = true;

        public object Result { get; private set; }

        public void SetReport(JObject report, bool switchView)
        {
            _report = report;
            _switchView = switchView;
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                Result = PanelBridge.PostSetReport(_report, _switchView);
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_show_report_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas show report";
    }

    internal class PanelShowResultEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);
        private JObject _spec;

        public object Result { get; private set; }

        public void SetResult(JObject spec)
        {
            _spec = spec;
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                PanelService.Instance.Show(app);
                Result = PanelBridge.PostSetResult(_spec);
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_show_result_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas show result";
    }

    internal class PanelSetViewEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);
        private string _view = "model";

        public object Result { get; private set; }

        public void SetView(string view)
        {
            _view = view;
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                // Ribbon Model/Report buttons already Show(); MCP panel_set_view must too
                // or geometry posts into a hidden / never-opened pane.
                PanelService.Instance.Show(app);
                Result = PanelBridge.PostSetView(_view);
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_set_view_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas set view";
    }

    internal class PanelFitEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);

        public object Result { get; private set; }

        public void Reset()
        {
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                PanelBridge.PostFit();
                Result = new { ok = true };
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_fit_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas fit";
    }

    internal class PanelClearEventHandler : IExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);
        private string _target = "all";

        public object Result { get; private set; }

        public void SetTarget(string target)
        {
            _target = string.IsNullOrWhiteSpace(target) ? "all" : target.Trim().ToLowerInvariant();
            Result = null;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                int deleted = 0;
                if (_target == "model" || _target == "all")
                    deleted = PanelMeshPayloadWriter.CleanOldGeometry(PanelService.Instance.PanelTmpFolder, keep: null);

                PanelBridge.PostClear(_target);
                Result = new { ok = true, target = _target, deletedTmpFiles = deleted };
            }
            catch (Exception ex)
            {
                PanelBridge.SetError(ex.Message);
                Result = new { ok = false, error = "panel_clear_failed", message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds) => _resetEvent.WaitOne(timeoutMilliseconds);

        public string GetName() => "MCP Agent Canvas clear";
    }
}
