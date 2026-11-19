using System;
using System.Collections.Generic;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPSDK.API.Interfaces;

namespace revit_mcp_plugin.Panel
{
    internal static class PanelCommandFactory
    {
        public static void Register(ICommandRegistry registry, UIApplication uiApp)
        {
            if (registry == null)
                throw new ArgumentNullException(nameof(registry));
            if (uiApp == null)
                throw new ArgumentNullException(nameof(uiApp));

            foreach (IRevitCommand command in CreateCommands(uiApp))
                registry.RegisterCommand(command);

            // ExternalEvent.Create must happen on a standard Revit API execution context.
            PickExternalEvent.Register();
            LoadGeometryExternalEvent.Register();
        }

        public static IList<IRevitCommand> CreateCommands(UIApplication uiApp)
        {
            return new IRevitCommand[]
            {
                new PanelShowGeometryCommand(uiApp),
                new PanelSetAnalysisCommand(uiApp),
                new PanelFitCommand(uiApp),
                new PanelClearCommand(uiApp),
                new PanelStatusCommand(uiApp),
                new PanelPickCommand(uiApp),
                new PanelCaptureCommand(uiApp),
            };
        }
    }

    /// <summary>
    /// Snapshot the Agent Canvas WebGL view. Runs on the socket thread (no ExternalEvent)
    /// so the WebView capture_result callback can complete without UI-thread deadlock.
    /// </summary>
    internal sealed class PanelCaptureCommand : IRevitCommand
    {
        public PanelCaptureCommand(UIApplication uiApp)
        {
        }

        public string CommandName => "panel_capture";

        public object Execute(JObject parameters, string requestId)
        {
            return PanelBridge.Capture(parameters, 20000);
        }
    }

    internal sealed class PanelShowGeometryCommand : ExternalEventCommandBase
    {
        private WaitablePanelShowGeometryHandler HandlerInstance => (WaitablePanelShowGeometryHandler)Handler;

        public PanelShowGeometryCommand(UIApplication uiApp)
            : base(new WaitablePanelShowGeometryHandler(), uiApp)
        {
        }

        public override string CommandName => "panel_show_geometry";

        public override object Execute(JObject parameters, string requestId)
        {
            JArray ids = parameters?["elementIds"] as JArray;
            bool selectedOnly = parameters?["selectedOnly"]?.Value<bool>() ?? false;

            HandlerInstance.SetParameters(ids, selectedOnly);
            // Extract can spend tens of seconds on high-poly families; keep above DefaultMaxElapsedMs.
            if (!RaiseAndWaitForCompletion(90000))
                throw CreateTimeoutException(CommandName);

            return HandlerInstance.Result;
        }
    }

    internal sealed class WaitablePanelShowGeometryHandler : PanelShowGeometryEventHandler, IWaitableExternalEventHandler
    {
    }

    internal sealed class PanelSetAnalysisCommand : ExternalEventCommandBase
    {
        private WaitablePanelSetAnalysisHandler HandlerInstance => (WaitablePanelSetAnalysisHandler)Handler;

        public PanelSetAnalysisCommand(UIApplication uiApp)
            : base(new WaitablePanelSetAnalysisHandler(), uiApp)
        {
        }

        public override string CommandName => "panel_set_analysis";

        public override object Execute(JObject parameters, string requestId)
        {
            var items = new List<PanelAnalysisItem>();
            if (parameters?["items"] is JArray array)
            {
                foreach (JToken token in array)
                {
                    if (token is not JObject obj)
                        continue;

                    long elementId = obj.Value<long?>("elementId") ?? 0;
                    if (elementId <= 0)
                        continue;

                    items.Add(new PanelAnalysisItem
                    {
                        ElementId = elementId,
                        Status = obj.Value<string>("status"),
                        Color = obj.Value<string>("color"),
                        Label = obj.Value<string>("label"),
                    });
                }
            }

            HandlerInstance.SetItems(items);
            if (!RaiseAndWaitForCompletion(10000))
                throw CreateTimeoutException(CommandName);

            return HandlerInstance.Result;
        }
    }

    internal sealed class WaitablePanelSetAnalysisHandler : PanelSetAnalysisEventHandler, IWaitableExternalEventHandler
    {
    }

    internal sealed class PanelFitCommand : ExternalEventCommandBase
    {
        private WaitablePanelFitHandler HandlerInstance => (WaitablePanelFitHandler)Handler;

        public PanelFitCommand(UIApplication uiApp)
            : base(new WaitablePanelFitHandler(), uiApp)
        {
        }

        public override string CommandName => "panel_fit";

        public override object Execute(JObject parameters, string requestId)
        {
            HandlerInstance.Reset();
            if (!RaiseAndWaitForCompletion(10000))
                throw CreateTimeoutException(CommandName);

            return HandlerInstance.Result;
        }
    }

    internal sealed class WaitablePanelFitHandler : PanelFitEventHandler, IWaitableExternalEventHandler
    {
    }

    internal sealed class PanelClearCommand : ExternalEventCommandBase
    {
        private WaitablePanelClearHandler HandlerInstance => (WaitablePanelClearHandler)Handler;

        public PanelClearCommand(UIApplication uiApp)
            : base(new WaitablePanelClearHandler(), uiApp)
        {
        }

        public override string CommandName => "panel_clear";

        public override object Execute(JObject parameters, string requestId)
        {
            HandlerInstance.SetTarget(parameters.Value<string>("target"));
            if (!RaiseAndWaitForCompletion(10000))
                throw CreateTimeoutException(CommandName);

            return HandlerInstance.Result;
        }
    }

    internal sealed class WaitablePanelClearHandler : PanelClearEventHandler, IWaitableExternalEventHandler
    {
    }

    internal sealed class PanelStatusCommand : ExternalEventCommandBase
    {
        private PanelStatusEventHandler HandlerInstance => (PanelStatusEventHandler)Handler;

        public PanelStatusCommand(UIApplication uiApp)
            : base(new PanelStatusEventHandler(), uiApp)
        {
        }

        public override string CommandName => "panel_status";

        public override object Execute(JObject parameters, string requestId)
        {
            if (!RaiseAndWaitForCompletion(10000))
                throw CreateTimeoutException(CommandName);

            return HandlerInstance.Result;
        }
    }

    internal sealed class PanelStatusEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);

        public object Result { get; private set; }

        public void Execute(UIApplication app)
        {
            Result = PanelBridge.GetStatus();
            _resetEvent.Set();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "MCP Agent Canvas status";
    }

    internal sealed class PanelPickCommand : ExternalEventCommandBase
    {
        private PanelPickEventHandler HandlerInstance => (PanelPickEventHandler)Handler;

        public PanelPickCommand(UIApplication uiApp)
            : base(new PanelPickEventHandler(), uiApp)
        {
        }

        public override string CommandName => "panel_pick";

        public override object Execute(JObject parameters, string requestId)
        {
            if (!RaiseAndWaitForCompletion(10000))
                throw CreateTimeoutException(CommandName);

            return HandlerInstance.Result;
        }
    }

    internal sealed class PanelPickEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new(false);

        public object Result { get; private set; }

        public void Execute(UIApplication app)
        {
            Result = new
            {
                lastPick = PanelBridge.LastPickElementId,
                lastPickAtUtc = PanelBridge.LastPickAtUtc,
            };
            _resetEvent.Set();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "MCP Agent Canvas pick";
    }
}
