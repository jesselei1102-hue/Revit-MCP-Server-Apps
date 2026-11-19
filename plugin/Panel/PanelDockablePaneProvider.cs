using System;
using System.Windows;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// Implements <see cref="IDockablePaneProvider"/> for the Agent Canvas pane.
    /// Revit calls <see cref="SetupDockablePane"/> during UI initialization.
    /// The WebView2 control is created on demand via <see cref="FrameworkElementCreator"/>.
    /// </summary>
    internal sealed class PanelDockablePaneProvider : IDockablePaneProvider
    {
        public void SetupDockablePane(DockablePaneProviderData data)
        {
            data.FrameworkElementCreator = new PanelFrameworkElementCreator();
            data.VisibleByDefault = false;
            data.InitialState = new DockablePaneState
            {
                DockPosition = DockPosition.Right,
                MinimumWidth = 320,
            };
        }
    }

    internal sealed class PanelFrameworkElementCreator : IFrameworkElementCreator
    {
        public FrameworkElement CreateFrameworkElement()
        {
            PanelService.Instance.CreateView();
            return PanelService.Instance.View;
        }
    }
}
