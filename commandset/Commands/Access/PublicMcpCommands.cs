using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPSDK.API.Base;
using System;

namespace RevitMCPCommandSet.Commands.Access
{
    public class QueryModelCommand : ExternalEventCommandBase
    {
        private QueryModelEventHandler _handler => (QueryModelEventHandler)Handler;
        public override string CommandName => "query_model";

        public QueryModelCommand(UIApplication uiApp) : base(new QueryModelEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.SetParameters(parameters?["input"] as JObject ?? parameters);
            if (RaiseAndWaitForCompletion(60000))
                return _handler.Result;
            throw new TimeoutException("query_model timed out");
        }
    }

    public class GetElementDataCommand : ExternalEventCommandBase
    {
        private GetElementDataEventHandler _handler => (GetElementDataEventHandler)Handler;
        public override string CommandName => "get_element_data";

        public GetElementDataCommand(UIApplication uiApp) : base(new GetElementDataEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.SetParameters(parameters);
            if (RaiseAndWaitForCompletion(60000))
                return _handler.Result;
            throw new TimeoutException("get_element_data timed out");
        }
    }

    public class OpenViewCommand : ExternalEventCommandBase
    {
        private OpenViewEventHandler _handler => (OpenViewEventHandler)Handler;
        public override string CommandName => "open_view";

        public OpenViewCommand(UIApplication uiApp) : base(new OpenViewEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.SetParameters(parameters);
            if (RaiseAndWaitForCompletion(15000))
                return _handler.Result;
            throw new TimeoutException("open_view timed out");
        }
    }

    public class ZoomToElementsCommand : ExternalEventCommandBase
    {
        private ZoomToElementsEventHandler _handler => (ZoomToElementsEventHandler)Handler;
        public override string CommandName => "zoom_to_elements";

        public ZoomToElementsCommand(UIApplication uiApp) : base(new ZoomToElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.SetParameters(parameters);
            if (RaiseAndWaitForCompletion(15000))
                return _handler.Result;
            throw new TimeoutException("zoom_to_elements timed out");
        }
    }

    public class SelectElementsCommand : ExternalEventCommandBase
    {
        private SelectElementsEventHandler _handler => (SelectElementsEventHandler)Handler;
        public override string CommandName => "select_elements";

        public SelectElementsCommand(UIApplication uiApp) : base(new SelectElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.SetParameters(parameters);
            if (RaiseAndWaitForCompletion(15000))
                return _handler.Result;
            throw new TimeoutException("select_elements timed out");
        }
    }

    public class ExportViewsCommand : ExternalEventCommandBase
    {
        private ExportViewsEventHandler _handler => (ExportViewsEventHandler)Handler;
        public override string CommandName => "export_views";

        public ExportViewsCommand(UIApplication uiApp) : base(new ExportViewsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.SetParameters(parameters);
            if (RaiseAndWaitForCompletion(180000))
                return _handler.Result;
            throw new TimeoutException("export_views timed out");
        }
    }

    public class GetRunningRevitInstancesCommand : ExternalEventCommandBase
    {
        private GetRunningRevitInstancesEventHandler _handler => (GetRunningRevitInstancesEventHandler)Handler;
        public override string CommandName => "get_running_revit_instances";

        public GetRunningRevitInstancesCommand(UIApplication uiApp)
            : base(new GetRunningRevitInstancesEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.Prepare();
            if (RaiseAndWaitForCompletion(10000))
                return _handler.Result;
            throw new TimeoutException("get_running_revit_instances timed out");
        }
    }
}
