using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using System;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Ribbon command: show/hide the Agent Canvas dockable pane.
    /// </summary>
    [Transaction(TransactionMode.Manual)]
    public class TogglePanelCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            try
            {
                bool shown = PanelService.Instance.Toggle(commandData.Application);
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return Result.Failed;
            }
        }
    }
}
