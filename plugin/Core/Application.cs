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

            // Agent Canvas dock: Model ribbon only. Schedule/GBP stay in Cursor MCP Apps;
            // Dynamic Report still reachable via panel_show_report / panel_set_view — no Report ribbon.
            PushButtonData modelData = new PushButtonData(
                "ID_EXCMD_MCP_PANEL_MODEL",
                "Model",
                assemblyPath,
                "revit_mcp_plugin.Panel.ShowModelViewCommand");
            modelData.ToolTip = "Open Agent Canvas on the Model (3D) view.";
            modelData.LongDescription = "Shows the Agent Canvas panel and switches to the 3D model view.";
            modelData.AvailabilityClassName = Availability;
            modelData.Image = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/panel-16.png", UriKind.RelativeOrAbsolute));
            modelData.LargeImage = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/panel-32.png", UriKind.RelativeOrAbsolute));

            PushButtonData hideData = new PushButtonData(
                RibbonButtonId,
                "Hide\r\nPanel",
                assemblyPath,
                "revit_mcp_plugin.Panel.TogglePanelCommand");
            hideData.ToolTip = "Show or hide the Agent Canvas panel.";
            hideData.AvailabilityClassName = Availability;
            hideData.Image = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/panel-16.png", UriKind.RelativeOrAbsolute));
            hideData.LargeImage = new BitmapImage(new Uri(resourcePrefix + ";component/Core/Ressources/panel-32.png", UriKind.RelativeOrAbsolute));

            mcpPanel.AddItem(modelData);
            mcpPanel.AddItem(hideData);

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
            // HUD "Load Revit view" / pick must work even before MCP is toggled On.
            PickExternalEvent.Register();
            LoadGeometryExternalEvent.Register(application);
            _uiControlled = application;
            application.Idling += HideCanvasOnStartup;

            return Result.Succeeded;
        }

        private static UIControlledApplication _uiControlled;

        /// <summary>
        /// Revit restores the last dock layout, so the canvas can come back open.
        /// Close it once at startup. The Model ribbon still opens it on demand.
        /// </summary>
        private static void HideCanvasOnStartup(object sender, Autodesk.Revit.UI.Events.IdlingEventArgs e)
        {
            if (_uiControlled != null)
            {
                _uiControlled.Idling -= HideCanvasOnStartup;
                _uiControlled = null;
            }

            if (!(sender is UIApplication uiApp))
                return;

            try
            {
                DockablePane pane = uiApp.GetDockablePane(PanelService.Instance.PaneId);
                if (pane != null && pane.IsShown())
                    pane.Hide();
            }
            catch
            {
                // Pane is not ready on the first idle. Leave it; the user can hide it from the ribbon.
            }
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            try
            {
                if (_uiControlled != null)
                {
                    _uiControlled.Idling -= HideCanvasOnStartup;
                    _uiControlled = null;
                }

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
