using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPMEPCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPMEPCommandSet.Commands
{
    public abstract class MepCommand : ExternalEventCommandBase
    {
        private readonly string _name;

        protected MepCommand(UIApplication uiApp, string name)
            : base(new MepEventHandler(), uiApp)
        {
            _name = name;
        }

        public override string CommandName => _name;

        public override object Execute(JObject parameters, string requestId)
        {
            var handler = (MepEventHandler)Handler;
            handler.Prepare(CommandName, parameters);
            if (!RaiseAndWaitForCompletion(120000))
                throw new TimeoutException(CommandName + " timed out.");
            if (handler.Error != null)
                throw new InvalidOperationException(handler.Error);
            return handler.Result;
        }
    }

    public sealed class GetPipeTypesCommand : MepCommand { public GetPipeTypesCommand(UIApplication uiApp) : base(uiApp, "get_pipe_types") { } }
    public sealed class GetPipeSystemTypesCommand : MepCommand { public GetPipeSystemTypesCommand(UIApplication uiApp) : base(uiApp, "get_pipe_system_types") { } }
    public sealed class GetPipesCommand : MepCommand { public GetPipesCommand(UIApplication uiApp) : base(uiApp, "get_pipes") { } }
    public sealed class GetDuctTypesCommand : MepCommand { public GetDuctTypesCommand(UIApplication uiApp) : base(uiApp, "get_duct_types") { } }
    public sealed class GetDuctSystemTypesCommand : MepCommand { public GetDuctSystemTypesCommand(UIApplication uiApp) : base(uiApp, "get_duct_system_types") { } }
    public sealed class GetDuctsCommand : MepCommand { public GetDuctsCommand(UIApplication uiApp) : base(uiApp, "get_ducts") { } }
    public sealed class GetCableTrayTypesCommand : MepCommand { public GetCableTrayTypesCommand(UIApplication uiApp) : base(uiApp, "get_cable_tray_types") { } }
    public sealed class GetCableTraysCommand : MepCommand { public GetCableTraysCommand(UIApplication uiApp) : base(uiApp, "get_cable_trays") { } }

    public sealed class CreatePipeCommand : MepCommand { public CreatePipeCommand(UIApplication uiApp) : base(uiApp, "create_pipe") { } }
    public sealed class ModifyPipeCommand : MepCommand { public ModifyPipeCommand(UIApplication uiApp) : base(uiApp, "modify_pipe") { } }
    public sealed class CreateDuctCommand : MepCommand { public CreateDuctCommand(UIApplication uiApp) : base(uiApp, "create_duct") { } }
    public sealed class ModifyDuctCommand : MepCommand { public ModifyDuctCommand(UIApplication uiApp) : base(uiApp, "modify_duct") { } }
    public sealed class CreateCableTrayCommand : MepCommand { public CreateCableTrayCommand(UIApplication uiApp) : base(uiApp, "create_cable_tray") { } }
    public sealed class ModifyCableTrayCommand : MepCommand { public ModifyCableTrayCommand(UIApplication uiApp) : base(uiApp, "modify_cable_tray") { } }

    public sealed class CreateMepFittingCommand : MepCommand { public CreateMepFittingCommand(UIApplication uiApp) : base(uiApp, "create_mep_fitting") { } }
    public sealed class CreatePipeElbowFittingCommand : MepCommand { public CreatePipeElbowFittingCommand(UIApplication uiApp) : base(uiApp, "create_pipe_elbow_fitting") { } }
    public sealed class CreatePipeTransitionFittingCommand : MepCommand { public CreatePipeTransitionFittingCommand(UIApplication uiApp) : base(uiApp, "create_pipe_transition_fitting") { } }
    public sealed class CreatePipeUnionFittingCommand : MepCommand { public CreatePipeUnionFittingCommand(UIApplication uiApp) : base(uiApp, "create_pipe_union_fitting") { } }
    public sealed class CreatePipeTeeFittingCommand : MepCommand { public CreatePipeTeeFittingCommand(UIApplication uiApp) : base(uiApp, "create_pipe_tee_fitting") { } }
    public sealed class CreatePipeCrossFittingCommand : MepCommand { public CreatePipeCrossFittingCommand(UIApplication uiApp) : base(uiApp, "create_pipe_cross_fitting") { } }
    public sealed class CreatePipeTakeoffFittingCommand : MepCommand { public CreatePipeTakeoffFittingCommand(UIApplication uiApp) : base(uiApp, "create_pipe_takeoff_fitting") { } }
    public sealed class CreateDuctElbowFittingCommand : MepCommand { public CreateDuctElbowFittingCommand(UIApplication uiApp) : base(uiApp, "create_duct_elbow_fitting") { } }
    public sealed class CreateDuctTransitionFittingCommand : MepCommand { public CreateDuctTransitionFittingCommand(UIApplication uiApp) : base(uiApp, "create_duct_transition_fitting") { } }
    public sealed class CreateDuctUnionFittingCommand : MepCommand { public CreateDuctUnionFittingCommand(UIApplication uiApp) : base(uiApp, "create_duct_union_fitting") { } }
    public sealed class CreateDuctTeeFittingCommand : MepCommand { public CreateDuctTeeFittingCommand(UIApplication uiApp) : base(uiApp, "create_duct_tee_fitting") { } }
    public sealed class CreateDuctCrossFittingCommand : MepCommand { public CreateDuctCrossFittingCommand(UIApplication uiApp) : base(uiApp, "create_duct_cross_fitting") { } }
    public sealed class CreateDuctTakeoffFittingCommand : MepCommand { public CreateDuctTakeoffFittingCommand(UIApplication uiApp) : base(uiApp, "create_duct_takeoff_fitting") { } }
    public sealed class CreateElbowFittingCommand : MepCommand { public CreateElbowFittingCommand(UIApplication uiApp) : base(uiApp, "create_elbow_fitting") { } }
    public sealed class CreateTransitionFittingCommand : MepCommand { public CreateTransitionFittingCommand(UIApplication uiApp) : base(uiApp, "create_transition_fitting") { } }
    public sealed class CreateUnionFittingCommand : MepCommand { public CreateUnionFittingCommand(UIApplication uiApp) : base(uiApp, "create_union_fitting") { } }
    public sealed class CreateTeeFittingCommand : MepCommand { public CreateTeeFittingCommand(UIApplication uiApp) : base(uiApp, "create_tee_fitting") { } }
    public sealed class CreateCrossFittingCommand : MepCommand { public CreateCrossFittingCommand(UIApplication uiApp) : base(uiApp, "create_cross_fitting") { } }
}
