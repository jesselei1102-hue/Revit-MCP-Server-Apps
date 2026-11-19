using System;
using Autodesk.Revit.UI;
using revit_mcp_plugin.Panel;
using System.Reflection;
using System.Windows.Media.Imaging;

namespace revit_mcp_plugin.Core
{
    public class Application : IExternalApplication
    {
        private const string PanelName = "Revit MCP Plugin";
        private const string PanelTitle = "MCP Agent Canvas";
        private const string RibbonButtonId = "ID_EXCMD_MCP_PANEL";
        private const string ToggleId = "ID_EXCMD_TOGGLE_REVIT_MCP";
        private const string SettingsId = "ID_EXCMD_MCP_SETTINGS";
        private const string Availability = "revit_mcp_plugin.Core.AlwaysAvailable";

        public Result OnStartup(UIControlledApplication application)
        {
            RibbonPanel mcpPanel = application.CreateRibbonPanel(PanelName);

            string assemblyPath = Assembly.GetExecutingAssembly().Location;
            string resourcePrefix = "/" + Assembly.GetExecutingAssembly().GetName().Name;
            int socketPort = PanelBuildInfo.SocketPort;

            PushButtonData toggleData = new PushButtonData(
                ToggleId,
                "MCP\r\nOff",
                assemblyPath,
                "revit_mcp_plugin.Core.MCPServiceConnection");
            toggleData.ToolTip = $"MCP server is off. Click to start on port {socketPort}.";
            toggleData.LongDescription = $"Start the socket server so Cursor can connect to Revit (port {socketPort}).";
            toggleData.AvailabilityClassName = Availability;
            toggleData.Image = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/icon-16.png", UriKind.RelativeOrAbsolute));
            toggleData.LargeImage = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/icon-32.png", UriKind.RelativeOrAbsolute));
            PushButton toggleButton = mcpPanel.AddItem(toggleData) as PushButton;
            McpToggleButton.Initialize(toggleButton);

            PushButtonData panelData = new PushButtonData(
                RibbonButtonId,
                "Panel",
                assemblyPath,
                "revit_mcp_plugin.Panel.TogglePanelCommand");
            panelData.ToolTip = "Show or hide the Agent Canvas panel.";
            panelData.LongDescription = "Dockable WebView2 canvas used by the agent to render 3D scenes and rich content inside Revit.";
            panelData.AvailabilityClassName = Availability;
            panelData.Image = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/panel-16.png", UriKind.RelativeOrAbsolute));
            panelData.LargeImage = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/panel-32.png", UriKind.RelativeOrAbsolute));
            mcpPanel.AddItem(panelData);

            PushButtonData settingsData = new PushButtonData(
                SettingsId,
                "Settings",
                assemblyPath,
                "revit_mcp_plugin.Core.Settings");
            settingsData.ToolTip = "MCP Settings";
            settingsData.AvailabilityClassName = Availability;
            settingsData.Image = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/settings-16.png", UriKind.RelativeOrAbsolute));
            settingsData.LargeImage = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/settings-32.png", UriKind.RelativeOrAbsolute));
            mcpPanel.AddItem(settingsData);

            PanelService.Instance.Register(application, PanelTitle);
            PanelDocumentSync.Initialize(application);

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            try
            {
                PanelDocumentSync.Shutdown();

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
