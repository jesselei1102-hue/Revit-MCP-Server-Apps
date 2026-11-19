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
    /// Singleton owner of the Agent Canvas dockable pane.
    /// Single backend: WebView2 (https://panel.local/). Three.js hosts the 3D scene,
    /// and the same container carries the dynamic report page.
    /// There is deliberately no Helix/SharpDX path — see HelixPanelController for the verdict.
    /// </summary>
    internal sealed class PanelService
    {
        private static PanelService _instance;

        public static PanelService Instance => _instance ??= new PanelService();

        private readonly DockablePaneId _paneId = new DockablePaneId(new Guid(PanelBuildInfo.PaneGuid));

        // Host chrome
        private Grid _view;
        private Grid _content;
        private TextBlock _title;

        // WebView backend
        private WebView2 _webView;
        private Grid _webViewHost;
        private TextBlock _fallback;
        private bool _webViewStarted;

        private bool _registered;
        private string _lastError;

        public DockablePaneId PaneId => _paneId;
        public FrameworkElement View => _view;
        public string LastError => _lastError;

        public bool WebViewReady => _webViewStarted;
        public string PanelFolder => System.IO.Path.Combine(
            System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location) ?? System.IO.Path.GetTempPath(),
            "panel-view");
        public string PanelTmpFolder => System.IO.Path.Combine(PanelFolder, "tmp");

        public void PostWebMessage(string json)
        {
            if (_webView?.CoreWebView2 == null)
            {
                WritePanelLog("post_web_message_skipped webview_not_ready");
                return;
            }

            WritePanelLog("post_web_message bytes=" + (json?.Length ?? 0));

            // Called from the Revit UI thread during ExternalEvent handlers.
            // Do NOT wait on the WPF Dispatcher here — the frame is blocked on this very call.
            // The WebView2 control was created on that same UI thread, so it can be used directly.
            if (_webView.Dispatcher.CheckAccess())
            {
                try
                {
                    _webView.CoreWebView2.PostWebMessageAsJson(json);
                }
                catch (Exception ex)
                {
                    WritePanelLog("post_web_message_failed: " + ex.Message);
                }
                return;
            }

            _webView.Dispatcher.InvokeAsync(() =>
            {
                try
                {
                    _webView?.CoreWebView2?.PostWebMessageAsJson(json);
                }
                catch (Exception ex)
                {
                    WritePanelLog("post_web_message_failed: " + ex.Message);
                }
            });
        }

        private PanelService() { }

        // ---------------------------------------------------------- registration

        /// <summary>
        /// Called once from IExternalApplication.OnStartup to register the pane with Revit.
        /// </summary>
        public void Register(UIControlledApplication application, string paneTitle)
        {
            if (_registered)
                return;

            application.RegisterDockablePane(_paneId, paneTitle ?? "MCP Agent Canvas", new PanelDockablePaneProvider());
            _registered = true;
        }

        internal void CreateView()
        {
            if (_view != null)
                return;

            _view = new Grid
            {
                Background = new SolidColorBrush(Color.FromRgb(0x11, 0x11, 0x14)),
            };
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

        // ---------------------------------------------------------- toggle

        /// <summary>
        /// Toggle pane visibility. Called by the ribbon command (has a UIApplication).
        /// </summary>
        public bool Toggle(UIApplication uiApp)
        {
            if (!_registered)
                return false;

            try
            {
                DockablePane pane = uiApp.GetDockablePane(_paneId);
                if (pane.IsShown())
                {
                    pane.Hide();
                    return false;
                }

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

        // ---------------------------------------------------------- WebView

        private FrameworkElement EnsureWebView()
        {
            if (_webViewHost != null)
                return _webViewHost;

            _webViewHost = new Grid
            {
                Background = new SolidColorBrush(Color.FromRgb(0x11, 0x11, 0x14)),
            };

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
            string assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
                ?? Path.GetTempPath();
            string userDataFolder = Path.Combine(assemblyDir, "WebView2UserData");
            try
            {
                Directory.CreateDirectory(userDataFolder);

                var options = new CoreWebView2EnvironmentOptions
                {
                    // Panel assets are local; keep the browser local-only.
                    AdditionalBrowserArguments = "--disable-features=msSmartScreenProtection",
                };

                CoreWebView2Environment environment = await CoreWebView2Environment
                    .CreateAsync(browserExecutableFolder: null,
                                  userDataFolder: userDataFolder,
                                  options: options)
                    .ConfigureAwait(true);

                await _webView.EnsureCoreWebView2Async(environment).ConfigureAwait(true);

                string panelFolder = Path.Combine(assemblyDir, "panel-view");
                Directory.CreateDirectory(panelFolder);
                Directory.CreateDirectory(Path.Combine(panelFolder, "tmp"));

                const string hostName = "panel.local";
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    hostName,
                    panelFolder,
                    CoreWebView2HostResourceAccessKind.Allow);

                _webView.CoreWebView2.NavigationStarting += (_, args) =>
                {
                    if (!IsAllowedNavigation(args.Uri))
                        args.Cancel = true;
                };

                _webView.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;

                _webView.CoreWebView2.Settings.AreDefaultScriptDialogsEnabled = false;
                _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;

                _webView.CoreWebView2.Navigate($"https://{hostName}/index.html");

                PanelBridge.RegisterWebView(_webView);
                _webViewStarted = true;
                if (_fallback != null)
                    _fallback.Visibility = Visibility.Collapsed;
                WritePanelLog("webview_ready host=panel.local folder=" + panelFolder);
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

        private static bool IsAllowedNavigation(string uri)
        {
            return uri != null
                && uri.StartsWith("https://panel.local/", StringComparison.OrdinalIgnoreCase);
        }

        // ---------------------------------------------------------- shared log

        internal void WritePanelLog(string message)
        {
            try
            {
                string assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string logs = Path.Combine(assemblyDir ?? Path.GetTempPath(), "Logs");
                Directory.CreateDirectory(logs);
                string path = Path.Combine(logs, $"panel-{DateTime.Now:yyyyMMdd}.log");
                File.AppendAllText(path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
            catch
            {
                // logging must never break the pane
            }
        }
    }
}
