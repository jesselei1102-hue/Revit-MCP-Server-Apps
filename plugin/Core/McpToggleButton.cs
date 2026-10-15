using Autodesk.Revit.UI;
using System;
using System.Reflection;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// Updates the MCP ribbon button so it reads as an on/off switch:
    /// label, tooltip, status LED, and pressed look.
    /// </summary>
    internal static class McpToggleButton
    {
        private const string Icon16 = "icon-16.png";
        private const string Icon32 = "icon-32.png";

        private static PushButton _button;
        private static BitmapSource _on16;
        private static BitmapSource _on32;
        private static BitmapSource _off16;
        private static BitmapSource _off32;

        public static void Initialize(PushButton button)
        {
            _button = button;
            EnsureIcons();
            Refresh();
        }

        public static void Refresh()
        {
            if (_button == null)
                return;

            SocketService service = SocketService.Instance;
            bool isOn = service.IsRunning;
            int port = service.Port;

            _button.ItemText = isOn ? "MCP\r\nOn" : "MCP\r\nOff";
            _button.ToolTip = isOn
                ? string.Format("MCP server is running on port {0}. Click to stop.", port)
                : string.Format("MCP server is off. Click to start on port {0}.", port);
            _button.LongDescription = isOn
                ? "Cursor and other MCP clients can send commands to this Revit session."
                : "Start the socket server so Cursor can connect to Revit.";

            if (_on16 != null)
            {
                _button.Image = isOn ? _on16 : _off16;
                _button.LargeImage = isOn ? _on32 : _off32;
            }

            SetPressed(_button, isOn);
        }

        private static void EnsureIcons()
        {
            if (_on32 != null)
                return;

            try
            {
                BitmapSource source16 = LoadResource(Icon16);
                BitmapSource source32 = LoadResource(Icon32);
                _on16 = WithStatusLed(source16, 16, true);
                _on32 = WithStatusLed(source32, 32, true);
                _off16 = WithStatusLed(source16, 16, false);
                _off32 = WithStatusLed(source32, 32, false);
            }
            catch
            {
                _on16 = _on32 = _off16 = _off32 = null;
            }
        }

        private static BitmapSource LoadResource(string fileName)
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.UriSource = new Uri(
                "/RevitMCPPlugin;component/Core/Ressources/" + fileName,
                UriKind.RelativeOrAbsolute);
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.EndInit();
            if (image.CanFreeze)
                image.Freeze();
            return image;
        }

        private static BitmapSource WithStatusLed(BitmapSource source, int size, bool isOn)
        {
            var visual = new DrawingVisual();
            using (DrawingContext dc = visual.RenderOpen())
            {
                dc.PushOpacity(isOn ? 1.0 : 0.72);
                dc.DrawImage(source, new Rect(0, 0, size, size));
                dc.Pop();

                double diameter = Math.Max(6.0, size * 0.30);
                double margin = Math.Max(1.0, size / 16.0);
                var center = new Point(size - diameter / 2.0 - margin, size - diameter / 2.0 - margin);
                Color fill = isOn
                    ? Color.FromRgb(0x22, 0xC5, 0x5E)
                    : Color.FromRgb(0x9C, 0xA3, 0xAF);
                var brush = new SolidColorBrush(fill);
                brush.Freeze();
                var ring = new Pen(Brushes.White, Math.Max(1.0, size / 16.0));
                ring.Freeze();
                dc.DrawEllipse(brush, ring, center, diameter / 2.0, diameter / 2.0);
            }

            var bitmap = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(visual);
            bitmap.Freeze();
            return bitmap;
        }

        /// <summary>
        /// Revit PushButton has no public Checked API. The hosted AdWindows
        /// item does, and making it checkable gives the native pressed look.
        /// </summary>
        private static void SetPressed(RibbonItem item, bool pressed)
        {
            try
            {
                object adItem = GetAdWindowsRibbonItem(item);
                if (adItem == null)
                    return;

                SetProperty(adItem, "IsCheckable", true);
                SetProperty(adItem, "IsChecked", pressed);
            }
            catch
            {
                // Pressed look is visual-only; label and LED still update.
            }
        }

        private static object GetAdWindowsRibbonItem(RibbonItem item)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
            Type type = item.GetType();

            while (type != null)
            {
                foreach (string name in new[] { "m_RibbonItem", "_ribbonItem", "m_Item" })
                {
                    FieldInfo field = type.GetField(name, flags);
                    if (field != null)
                    {
                        object value = field.GetValue(item);
                        if (value != null)
                            return value;
                    }
                }

                foreach (string name in new[] { "RibbonItem", "UIRibbonItem" })
                {
                    PropertyInfo prop = type.GetProperty(name, flags);
                    if (prop != null && prop.GetIndexParameters().Length == 0)
                    {
                        object value = prop.GetValue(item, null);
                        if (value != null && !ReferenceEquals(value, item))
                            return value;
                    }
                }

                foreach (string name in new[] { "getRibbonItem", "get_RibbonItem" })
                {
                    MethodInfo method = type.GetMethod(name, flags, null, Type.EmptyTypes, null);
                    if (method != null)
                    {
                        object value = method.Invoke(item, null);
                        if (value != null && !ReferenceEquals(value, item))
                            return value;
                    }
                }

                type = type.BaseType;
            }

            return null;
        }

        private static void SetProperty(object target, string name, object value)
        {
            PropertyInfo prop = target.GetType().GetProperty(
                name,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (prop != null && prop.CanWrite)
                prop.SetValue(target, value, null);
        }
    }
}
