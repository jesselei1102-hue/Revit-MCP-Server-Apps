using System;
using Autodesk.Revit.UI;
using System.Reflection;
using System.Windows.Media.Imaging;

namespace revit_mcp_plugin.Core
{
    public class Application : IExternalApplication
    {
        private const string Availability = "revit_mcp_plugin.Core.AlwaysAvailable";

        public Result OnStartup(UIControlledApplication application)
        {
            RibbonPanel mcpPanel = application.CreateRibbonPanel("Revit MCP Plugin");

            PushButtonData pushButtonData = new PushButtonData(
                "ID_EXCMD_TOGGLE_REVIT_MCP",
                "MCP\r\nOff",
                Assembly.GetExecutingAssembly().Location,
                "revit_mcp_plugin.Core.MCPServiceConnection");
            pushButtonData.ToolTip = "MCP server is off. Click to start on port 8080.";
            pushButtonData.LongDescription = "Start the socket server so Cursor can connect to Revit.";
            pushButtonData.AvailabilityClassName = Availability;
            pushButtonData.Image = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/icon-16.png", UriKind.RelativeOrAbsolute));
            pushButtonData.LargeImage = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/icon-32.png", UriKind.RelativeOrAbsolute));
            PushButton toggleButton = mcpPanel.AddItem(pushButtonData) as PushButton;
            McpToggleButton.Initialize(toggleButton);

            PushButtonData mcp_settings_pushButtonData = new PushButtonData(
                "ID_EXCMD_MCP_SETTINGS",
                "Settings",
                Assembly.GetExecutingAssembly().Location,
                "revit_mcp_plugin.Core.Settings");
            mcp_settings_pushButtonData.ToolTip = "MCP Settings";
            mcp_settings_pushButtonData.AvailabilityClassName = Availability;
            mcp_settings_pushButtonData.Image = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/settings-16.png", UriKind.RelativeOrAbsolute));
            mcp_settings_pushButtonData.LargeImage = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/settings-32.png", UriKind.RelativeOrAbsolute));
            mcpPanel.AddItem(mcp_settings_pushButtonData);

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            try
            {
                if (SocketService.Instance.IsRunning)
                {
                    SocketService.Instance.Stop();
                }
            }
            catch { }

            return Result.Succeeded;
        }
    }
}
