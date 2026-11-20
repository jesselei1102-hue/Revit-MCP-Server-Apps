using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Autodesk.Revit.UI;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// One dockable Agent Canvas: Model (3D) + Dynamic Report (panel_show_report).
    /// Schedule / GBP are not hosted in the panel (use Cursor MCP Apps instead).
    /// </summary>
    internal sealed class PanelService
    {
        private static PanelService _instance;

        public static PanelService Instance => _instance ??= new PanelService();

        private readonly DockablePaneId _paneId = new DockablePaneId(new Guid(PanelBuildInfo.PaneGuid));

        private Grid _view;
        private Grid _content;
        private TextBlock _title;

        private WebView2 _webView;
        private Grid _webViewHost;
        private TextBlock _fallback;
        private bool _webViewStarted;
        private string _activeSurface = "model";

        private bool _registered;
        private string _lastError;

        public DockablePaneId PaneId => _paneId;
        public FrameworkElement View => _view;
        public string LastError => _lastError;
        public bool WebViewReady => _webViewStarted;
        public bool AppWebViewReady => false;
        public string ActiveApp => null;
        public string ActiveSurface => _activeSurface;

        public string PanelFolder => Path.Combine(
            Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? Path.GetTempPath(),
            "panel-view");
        public string PanelTmpFolder => Path.Combine(PanelFolder, "tmp");

        public void PostWebMessage(string json)
        {
            WebView2 target = _webView;

            if (target?.CoreWebView2 == null)
            {
                WritePanelLog("post_web_message_skipped webview_not_ready");
                return;
            }

            WritePanelLog("post_web_message bytes=" + (json?.Length ?? 0) + " surface=" + _activeSurface);

            void Send()
            {
                try { target.CoreWebView2?.PostWebMessageAsJson(json); }
                catch (Exception ex) { WritePanelLog("post_web_message_failed: " + ex.Message); }
            }

            if (target.Dispatcher.CheckAccess()) Send();
            else target.Dispatcher.InvokeAsync(Send);
        }

        /// <summary>model | report — both on the single WebView2 (index.html).</summary>
        public void SetSurface(string surface)
        {
            void Apply()
            {
                string next = (surface ?? "model").Trim().ToLowerInvariant();
                if (next != "report") next = "model";

                _activeSurface = next;
                if (_title != null)
                    _title.Text = next == "report" ? "Agent Canvas · Report" : "Agent Canvas · Model";
                WritePanelLog("surface=main:" + next);
            }

            if (_view == null)
            {
                WritePanelLog("set_surface_skipped view_not_created");
                return;
            }

            if (_view.Dispatcher.CheckAccess()) Apply();
            else _view.Dispatcher.InvokeAsync(Apply);
        }

        private PanelService() { }

        public void Register(UIControlledApplication application, string paneTitle)
        {
            if (_registered) return;
            application.RegisterDockablePane(_paneId, paneTitle ?? "MCP Agent Canvas", new PanelDockablePaneProvider());
            _registered = true;
        }

        internal void CreateView()
        {
            if (_view != null) return;

            _view = new Grid { Background = new SolidColorBrush(Color.FromRgb(0x11, 0x11, 0x14)) };
            _view.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _view.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

            var chrome = new Grid
            {
                Background = new SolidColorBrush(Color.FromRgb(0x1B, 0x1B, 0x22)),
                Height = 34,
            };
            _title = new TextBlock
            {
                Text = "Agent Canvas",
                Foreground = Brushes.White,
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(10, 0, 10, 0),
            };
            chrome.Children.Add(_title);
            Grid.SetRow(chrome, 0);
            _view.Children.Add(chrome);

            _content = new Grid();
            Grid.SetRow(_content, 1);
            _view.Children.Add(_content);

            EnsureWebView();
            _content.Children.Add(_webViewHost);
        }

        public bool Toggle(UIApplication uiApp)
        {
            if (!_registered) return false;
            try
            {
                DockablePane pane = uiApp.GetDockablePane(_paneId);
                if (pane.IsShown()) { pane.Hide(); return false; }
                pane.Show();
                return true;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                WritePanelLog("toggle_failed: " + ex);
                return false;
            }
        }

        public void Show(UIApplication uiApp)
        {
            if (!_registered || uiApp == null) return;
            try
            {
                DockablePane pane = uiApp.GetDockablePane(_paneId);
                if (!pane.IsShown()) pane.Show();
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                WritePanelLog("show_failed: " + ex);
            }
        }

        private FrameworkElement EnsureWebView()
        {
            if (_webViewHost != null) return _webViewHost;

            _webViewHost = new Grid { Background = new SolidColorBrush(Color.FromRgb(0x11, 0x11, 0x14)) };
            _webView = new WebView2();
            _webViewHost.Children.Add(_webView);
            _fallback = new TextBlock
            {
                Text = "Starting WebView…",
                Foreground = new SolidColorBrush(Color.FromRgb(0xA8, 0xA8, 0xB0)),
                FontSize = 12,
                Margin = new Thickness(16),
                TextWrapping = TextWrapping.Wrap,
                VerticalAlignment = VerticalAlignment.Center,
            };
            _webViewHost.Children.Add(_fallback);
            _ = InitializeWebViewAsync();
            return _webViewHost;
        }

        private async Task InitializeWebViewAsync()
        {
            try
            {
                var env = await CreateEnvironmentAsync("WebView2UserData").ConfigureAwait(true);
                await ConfigureWebViewAsync(_webView, env, "https://panel.local/index.html").ConfigureAwait(true);
                PanelBridge.RegisterWebView(_webView);
                _webViewStarted = true;
                if (_fallback != null) _fallback.Visibility = Visibility.Collapsed;
                WritePanelLog("webview_ready host=panel.local folder=" + PanelFolder);
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                WritePanelLog("webview_init_failed: " + ex);
                if (_fallback != null)
                {
                    _fallback.Text = BuildRuntimeMissingMessage(ex);
                    _fallback.Visibility = Visibility.Visible;
                }
            }
        }

        private async Task<CoreWebView2Environment> CreateEnvironmentAsync(string folderName)
        {
            string assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? Path.GetTempPath();
            string userDataFolder = Path.Combine(assemblyDir, folderName);
            Directory.CreateDirectory(userDataFolder);
            Directory.CreateDirectory(PanelFolder);
            Directory.CreateDirectory(PanelTmpFolder);

            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = "--disable-features=msSmartScreenProtection",
            };
            return await CoreWebView2Environment
                .CreateAsync(null, userDataFolder, options)
                .ConfigureAwait(true);
        }

        private async Task ConfigureWebViewAsync(WebView2 webView, CoreWebView2Environment environment, string url)
        {
            await webView.EnsureCoreWebView2Async(environment).ConfigureAwait(true);
            webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "panel.local", PanelFolder, CoreWebView2HostResourceAccessKind.Allow);
            webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!IsAllowedNavigation(args.Uri)) args.Cancel = true;
            };
            webView.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
            webView.CoreWebView2.Settings.AreDefaultScriptDialogsEnabled = false;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Navigate(url);
        }

        private static string BuildRuntimeMissingMessage(Exception ex)
        {
            var builder = new StringBuilder();
            builder.AppendLine("Agent Canvas could not start WebView2.");
            builder.AppendLine();
            builder.AppendLine("Install the x64 Evergreen Runtime:");
            builder.AppendLine("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            builder.AppendLine();
            builder.AppendLine("Details: " + ex.Message);
            return builder.ToString();
        }

        private static bool IsAllowedNavigation(string uri) =>
            uri != null && uri.StartsWith("https://panel.local/", StringComparison.OrdinalIgnoreCase);

        internal void WritePanelLog(string message)
        {
            try
            {
                string assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string logs = Path.Combine(assemblyDir ?? Path.GetTempPath(), "Logs");
                Directory.CreateDirectory(logs);
                File.AppendAllText(
                    Path.Combine(logs, $"panel-{DateTime.Now:yyyyMMdd}.log"),
                    $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
            catch { }
        }
    }
}
