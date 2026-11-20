using System;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Panel
{
    /// <summary>Model / Report ribbons → one dockable Agent Canvas.</summary>
    internal static class PanelViewRibbon
    {
        public static Result ShowAndSetView(UIApplication uiApp, string view, ref string message)
        {
            try
            {
                PanelService.Instance.Show(uiApp);
                PanelBridge.PostSetView(view);
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return Result.Failed;
            }
        }
    }

    [Transaction(TransactionMode.Manual)]
    public class ShowModelViewCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
            => PanelViewRibbon.ShowAndSetView(commandData.Application, "model", ref message);
    }

    [Transaction(TransactionMode.Manual)]
    public class ShowReportViewCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
            => PanelViewRibbon.ShowAndSetView(commandData.Application, "report", ref message);
    }
}
