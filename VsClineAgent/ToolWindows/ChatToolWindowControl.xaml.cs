using System;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json;
using VsClineAgent.Agent;
using VsClineAgent.Services;

namespace VsClineAgent.ToolWindows
{
    public partial class ChatToolWindowControl : UserControl
    {
        private AgentController _agentController;
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
                _agentController.AgentEvent += OnAgentEvent;

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
            try
            {
                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "VsClineAgent", "WebView2Data");

                Directory.CreateDirectory(userDataFolder);
                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(env);

                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                webView.CoreWebView2.Settings.IsScriptEnabled = true;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;

                var htmlPath = Path.Combine(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                    "WebApp", "index.html");

                if (File.Exists(htmlPath))
                    webView.CoreWebView2.Navigate(new Uri(htmlPath).AbsoluteUri);
                else
                    ShowError($"WebApp not found at:\n{htmlPath}\n\nEnsure WebApp files are included in the VSIX.");
            }
            catch (Exception ex)
            {
                ShowError($"WebView2 init failed:\n{ex.Message}\n\nInstall WebView2 Runtime from microsoft.com/edge/webview2");
            }
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                ShowError($"Page load failed: {e.WebErrorStatus}");
                return;
            }

            _webViewReady = true;
            Dispatcher.Invoke(() =>
            {
                loadingPanel.Visibility = Visibility.Collapsed;
                webView.Visibility = Visibility.Visible;
            });

            var settings = _settingsService.Load();
            var workspaceRoot = await _editorService.GetSolutionRootAsync() ?? "";
            var openFiles = await _editorService.GetOpenDocumentsAsync();

            await SendToWebViewAsync(new { type = "init", settings, workspaceRoot, openFiles });
        }

        private async void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var msg = JsonConvert.DeserializeObject<WebMessage>(e.WebMessageAsJson);
                if (msg == null) return;

                switch (msg.Type)
                {
                    case "sendMessage":
                        if (msg.Content != null)
                            _ = StartAgentTaskAsync(msg.Content);
                        break;

                    case "approveAction":
                        _agentController?.SetApproval(true);
                        break;

                    case "rejectAction":
                        _agentController?.SetApproval(false);
                        break;

                    case "userAnswer":
                        _agentController?.SetUserInput(msg.Content ?? "");
                        break;

                    case "stopAgent":
                        _agentController?.Stop();
                        break;

                    case "updateSettings":
                        if (msg.Settings != null)
                        {
                            _settingsService.Save(msg.Settings);
                            _agentController?.UpdateSettings();
                        }
                        break;

                    case "getSettings":
                        var s = _settingsService.Load();
                        await SendToWebViewAsync(new { type = "settings", data = s });
                        break;

                    case "clearHistory":
                        // StartTaskAsync resets history on each new task — nothing extra needed
                        await SendToWebViewAsync(new { type = "historyCleared" });
                        break;

                    case "getWorkspaceContext":
                        var root = await _editorService.GetSolutionRootAsync() ?? "";
                        var files = await _editorService.GetOpenDocumentsAsync();
                        await SendToWebViewAsync(new { type = "workspaceContext", root, openFiles = files });
                        break;
                }
            }
            catch (Exception ex)
            {
                await SendToWebViewAsync(new { type = "error", message = ex.Message });
            }
        }

        private async Task StartAgentTaskAsync(string content)
        {
            var workspaceRoot = await _editorService.GetSolutionRootAsync() ?? "";
            await _agentController.StartTaskAsync(content, workspaceRoot);
        }

        private async void OnAgentEvent(object sender, AgentEvent e)
        {
            if (!_webViewReady) return;
            await SendToWebViewAsync(e.ToWebPayload());
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
                        await webView.CoreWebView2.ExecuteScriptAsync(
                            $"window.__agentBridge && window.__agentBridge.receive({json})");
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

        private class WebMessage
        {
            [JsonProperty("type")]     public string Type { get; set; } = "";
            [JsonProperty("content")]  public string Content { get; set; }
            [JsonProperty("toolCallId")] public string ToolCallId { get; set; }
            [JsonProperty("settings")] public AgentSettings Settings { get; set; }
        }
    }
}
