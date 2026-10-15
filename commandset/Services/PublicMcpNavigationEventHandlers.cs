using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace RevitMCPCommandSet.Services
{
    public class OpenViewEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public JObject Parameters { get; private set; }
        public object Result { get; private set; }

        public void SetParameters(JObject parameters)
        {
            Parameters = parameters;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            try
            {
                var uiDoc = app.ActiveUIDocument;
                var doc = uiDoc.Document;
                var viewId = Parameters?["viewId"]?.ToObject<long>()
                             ?? throw new ArgumentException("viewId is required");
                if (doc.GetElement(PublicMcpUtils.Id(viewId)) is not View view)
                    throw new Exception($"View {viewId} was not found");
                PublicMcpUtils.RequestOpenView(uiDoc, view);
                Result = new
                {
                    success = true,
                    viewId = view.Id.GetValue(),
                    name = view.Name,
                    viewType = view.ViewType.ToString()
                };
            }
            catch (Exception ex)
            {
                Result = new { success = false, message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "open_view";
    }

    public class ZoomToElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public JObject Parameters { get; private set; }
        public object Result { get; private set; }

        public void SetParameters(JObject parameters)
        {
            Parameters = parameters;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) => _resetEvent.WaitOne(timeoutMilliseconds);

        public void Execute(UIApplication app)
        {
            try
            {
                var uiDoc = app.ActiveUIDocument;
                var doc = uiDoc.Document;
                var ids = (Parameters?["elementIds"]?.ToObject<List<long>>() ?? new List<long>())
                    .Select(PublicMcpUtils.Id)
                    .ToList();
                if (ids.Count == 0)
                    throw new ArgumentException("No element(s) to show. None of the provided element Ids displays in the active view.");

                var missing = ids.Where(id => doc.GetElement(id) == null).Select(id => id.GetValue()).ToList();
                var existing = ids.Where(id => doc.GetElement(id) != null).ToList();
                if (existing.Count == 0)
                    throw new Exception("None of the provided element Ids exist in the document.");

                var view = uiDoc.ActiveView ?? throw new Exception("Current view not found.");
                var visible = existing.Where(id =>
                {
                    var element = doc.GetElement(id);
                    return element.get_BoundingBox(view) != null || element.get_BoundingBox(null) != null;
                }).ToList();
                if (visible.Count == 0)
                    throw new Exception("No element(s) to show. None of the provided element Ids displays in the active view.");

                try
                {
                    uiDoc.ShowElements(visible);
                }
                catch (Exception)
                {
                    ZoomToBoundingBox(uiDoc, visible);
                }

                Result = new
                {
                    success = true,
                    count = visible.Count,
                    missingIds = missing
                };
            }
            catch (Exception ex)
            {
                Result = new { success = false, message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        private static void ZoomToBoundingBox(UIDocument uiDoc, List<ElementId> ids)
        {
            var doc = uiDoc.Document;
            var view = uiDoc.ActiveView;
            XYZ min = null;
            XYZ max = null;
            foreach (var id in ids)
            {
                var element = doc.GetElement(id);
                var box = element?.get_BoundingBox(view) ?? element?.get_BoundingBox(null);
                if (box == null)
                    continue;
                min = min == null ? box.Min : new XYZ(Math.Min(min.X, box.Min.X), Math.Min(min.Y, box.Min.Y), Math.Min(min.Z, box.Min.Z));
                max = max == null ? box.Max : new XYZ(Math.Max(max.X, box.Max.X), Math.Max(max.Y, box.Max.Y), Math.Max(max.Z, box.Max.Z));
            }

            if (min == null || max == null)
                throw new Exception("No element(s) to show. None of the provided element Ids displays in the active view.");

            var uiView = uiDoc.GetOpenUIViews().FirstOrDefault(open => open.ViewId == view.Id)
                         ?? uiDoc.GetOpenUIViews().FirstOrDefault();
            if (uiView == null)
                throw new Exception("Cannot zoom - cannot find view to show element(s) in.");

            uiView.ZoomAndCenterRectangle(min, max);
        }

        public string GetName() => "zoom_to_elements";
    }

    public class SelectElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public JObject Parameters { get; private set; }
        public object Result { get; private set; }

        public void SetParameters(JObject parameters)
        {
            Parameters = parameters;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) => _resetEvent.WaitOne(timeoutMilliseconds);

        public void Execute(UIApplication app)
        {
            try
            {
                var uiDoc = app.ActiveUIDocument;
                var doc = uiDoc.Document;
                var ids = (Parameters?["elementIds"]?.ToObject<List<long>>() ?? new List<long>())
                    .Select(PublicMcpUtils.Id)
                    .ToList();
                if (ids.Count == 0)
                    throw new ArgumentException("No elements to select.");

                var missing = ids.Where(id => doc.GetElement(id) == null).Select(id => id.GetValue()).ToList();
                var existing = ids.Where(id => doc.GetElement(id) != null).ToList();
                if (existing.Count == 0)
                    throw new Exception("None of the provided element Ids exist in the document.");

                uiDoc.Selection.SetElementIds(existing);
                Result = new
                {
                    success = true,
                    count = existing.Count,
                    missingIds = missing
                };
            }
            catch (Exception ex)
            {
                Result = new { success = false, message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "select_elements";
    }

    public class GetRunningRevitInstancesEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public object Result { get; private set; }

        public void Prepare() => _resetEvent.Reset();

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            try
            {
                var doc = app.ActiveUIDocument?.Document;
                Result = new
                {
                    processId = Process.GetCurrentProcess().Id,
                    documentName = doc?.Title,
                    documentPath = doc?.PathName,
                    revitVersion = app.Application.VersionNumber
                };
            }
            catch (Exception ex)
            {
                Result = new { success = false, message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "get_running_revit_instances";
    }
}
