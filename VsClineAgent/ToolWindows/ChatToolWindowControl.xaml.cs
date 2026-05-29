using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json;
using VsClineAgent.Bridge;
using VsClineAgent.Agent;
using VsClineAgent.Services;

namespace VsClineAgent.ToolWindows
{
    public partial class ChatToolWindowControl : UserControl
    {
        private AgentController _agentController;
        private VisualStudioClineBridge _bridge;
        private readonly SettingsService _settingsService;
        private readonly VsEditorService _editorService;
        private bool _webViewReady;

        public ChatToolWindowControl()
        {
            InitializeComponent();
            _settingsService = new SettingsService();
            _editorService = new VsEditorService();
            Loaded += OnLoaded;
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            try
            {
                _agentController = new AgentController(_settingsService, _editorService);
                _bridge = new VisualStudioClineBridge(_agentController, _settingsService, _editorService, SendToWebViewAsync);

                SetStatus("Initializing WebView2...");
                await InitializeWebViewAsync();
            }
            catch (Exception ex)
            {
                ShowError($"Initialization failed:\n{ex.Message}");
            }
        }

        private async Task InitializeWebViewAsync()
        {
            var assemblyDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
                ?? AppDomain.CurrentDomain.BaseDirectory;
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent", "WebView2Data");
            string? browserExecutableFolder = null;

            try
            {
                Directory.CreateDirectory(userDataFolder);
                browserExecutableFolder = FindBundledWebView2Runtime(assemblyDirectory);

                if (!string.IsNullOrEmpty(browserExecutableFolder))
                    SetStatus("Initializing WebView2 from bundled runtime...");

                var env = await CoreWebView2Environment.CreateAsync(browserExecutableFolder, userDataFolder);
                await webView.EnsureCoreWebView2Async(env);

                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
(function () {
    if (window.__vsClineAcquireVsCodeApi) {
        return;
    }

    let vscodeState = {};
    const api = {
        postMessage: function (message) { window.chrome.webview.postMessage(message); },
        setState: function (state) { vscodeState = state || {}; return vscodeState; },
        getState: function () { return vscodeState; }
    };

    window.__vsClineAcquireVsCodeApi = api;
    window.acquireVsCodeApi = function () { return api; };

    window.chrome.webview.addEventListener('message', function (event) {
        window.dispatchEvent(new MessageEvent('message', { data: event.data }));
    });
})();");

                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                webView.CoreWebView2.Settings.IsScriptEnabled = true;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;

                var htmlPath = Path.Combine(
                    assemblyDirectory,
                    "WebApp", "index.html");

                if (File.Exists(htmlPath))
                    webView.CoreWebView2.Navigate(new Uri(htmlPath).AbsoluteUri);
                else
                    ShowError($"WebApp not found at:\n{htmlPath}\n\nEnsure WebApp files are included in the VSIX.");
            }
            catch (Exception ex)
            {
                ShowError(BuildWebView2InitializationError(ex, assemblyDirectory, browserExecutableFolder));
            }
        }

        private static string BuildWebView2InitializationError(
            Exception ex,
            string assemblyDirectory,
            string? browserExecutableFolder)
        {
            var bundledRuntimeRoot = Path.Combine(assemblyDirectory, "WebView2Runtime");
            var localRuntimeRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime");

            var detail = string.IsNullOrEmpty(browserExecutableFolder)
                ? "No system WebView2 Runtime was found, and no bundled Fixed Version Runtime was detected."
                : $"Bundled runtime was detected at:\n{browserExecutableFolder}";

            return
                $"WebView2 init failed:\n{ex.Message}\n\n{detail}\n\n" +
                "For air-gapped use, extract a WebView2 Fixed Version Runtime so msedgewebview2.exe exists under one of these locations:\n" +
                $"{bundledRuntimeRoot}\\<version>\\msedgewebview2.exe\n" +
                $"{localRuntimeRoot}\\<version>\\msedgewebview2.exe";
        }

        private static string? FindBundledWebView2Runtime(string assemblyDirectory)
        {
            foreach (var candidateRoot in GetWebView2RuntimeCandidateRoots(assemblyDirectory))
            {
                var runtimeFolder = FindRuntimeFolder(candidateRoot);
                if (!string.IsNullOrEmpty(runtimeFolder))
                    return runtimeFolder;
            }

            return null;
        }

        private static IEnumerable<string> GetWebView2RuntimeCandidateRoots(string assemblyDirectory)
        {
            yield return Path.Combine(assemblyDirectory, "WebView2Runtime");
            yield return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime");
        }

        private static string? FindRuntimeFolder(string candidateRoot)
        {
            if (string.IsNullOrWhiteSpace(candidateRoot) || !Directory.Exists(candidateRoot))
                return null;

            if (File.Exists(Path.Combine(candidateRoot, "msedgewebview2.exe")))
                return candidateRoot;

            foreach (var subDirectory in Directory.EnumerateDirectories(candidateRoot))
            {
                if (File.Exists(Path.Combine(subDirectory, "msedgewebview2.exe")))
                    return subDirectory;
            }

            return null;
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                ShowError($"Page load failed: {e.WebErrorStatus}");
                return;
            }

             _webViewReady = true;
             await _bridge.InitializeAsync();
             Dispatcher.Invoke(() =>
             {
                 loadingPanel.Visibility = Visibility.Collapsed;
                 webView.Visibility = Visibility.Visible;
             });
         }

         private async void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
         {
             try
             {
                 if (_bridge != null)
                     await _bridge.HandleWebMessageAsync(e.WebMessageAsJson);
             }
             catch (Exception ex)
             {
                await SendToWebViewAsync(new { type = "error", message = ex.Message });
            }
        }

        public async Task SendToWebViewAsync(object payload)
        {
            if (!_webViewReady) return;
            try
            {
                var json = JsonConvert.SerializeObject(payload);
                await Dispatcher.InvokeAsync(async () =>
                {
                    try
                    {
                        webView.CoreWebView2.PostWebMessageAsJson(json);
                    }
                    catch { }
                });
            }
            catch { }
        }

        private void SetStatus(string message)
        {
            Dispatcher.Invoke(() => statusText.Text = message);
        }

        private void ShowError(string message)
        {
            Dispatcher.Invoke(() =>
            {
                loadingPanel.Visibility = Visibility.Collapsed;
                webView.Visibility = Visibility.Collapsed;
                errorText.Text = message;
                errorText.Visibility = Visibility.Visible;
            });
        }
    }
}
