using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host;
using VsClineAgent.Services;

namespace VsClineAgent.ToolWindows
{
    public partial class ChatToolWindowControl : UserControl, IDisposable
    {
        static ChatToolWindowControl()
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveControlAssembly;
        }

        private static Assembly? ResolveControlAssembly(object? sender, ResolveEventArgs args)
        {
            try
            {
                var requestedAssembly = new AssemblyName(args.Name);
                var controlAssembly = typeof(ChatToolWindowControl).Assembly;
                return string.Equals(
                    requestedAssembly.Name,
                    controlAssembly.GetName().Name,
                    StringComparison.OrdinalIgnoreCase)
                    ? controlAssembly
                    : null;
            }
            catch
            {
                return null;
            }
        }

        private readonly SidecarLifecycle _sidecar;
        private string? _assemblyDirectory;
        private string? _lastWebMessageJson;
        private readonly WebviewMessageQueue _webviewMessages;
        private readonly UiThemePreferenceStore _themePreferences;
        private bool _loaded;
        private bool _disposed;
        private CancellationTokenSource? _pendingUnloadDispose;

        public ChatToolWindowControl()
        {
            InitializeComponent();
			_themePreferences = new UiThemePreferenceStore();
			_webviewMessages = new WebviewMessageQueue(() => webView.CoreWebView2);
			ApplyLoadingTheme(_themePreferences.Read());
            InitializeLoadingLogo();
            _sidecar = new SidecarLifecycle(
                new VsEditorService(),
                new VsCommandExecutionService(new VisualStudioOutputPaneWriter()),
                SetStatus);
            Loaded += OnLoaded;
            Unloaded += OnUnloaded;
        }

        private void InitializeLoadingLogo()
        {
            try
            {
                var assemblyDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
                    ?? AppDomain.CurrentDomain.BaseDirectory;
                var logoPath = Path.Combine(assemblyDirectory, "Assets", "lig-mark-white.png");
                if (!File.Exists(logoPath))
                    return;

                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.UriSource = new Uri(logoPath, UriKind.Absolute);
                bitmap.EndInit();
                bitmap.Freeze();
                loadingLogoImage.Source = bitmap;
            }
            catch
            {
            }
        }

		private static SolidColorBrush ThemeBrush(string color)
		{
			var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));
			brush.Freeze();
			return brush;
		}

		private void ApplyLoadingTheme(string theme)
		{
			void Apply()
			{
				var isLight = string.Equals(theme, UiThemePreferenceStore.LightTheme, StringComparison.OrdinalIgnoreCase);
				Background = ThemeBrush(isLight ? "#F7F8FA" : "#1E1E1E");
				loadingTitleText.Foreground = ThemeBrush(isLight ? "#172033" : "#CCCCCC");
				loadingBrandText.Foreground = ThemeBrush(isLight ? "#4B5563" : "#888888");
				statusText.Foreground = ThemeBrush(isLight ? "#4B5563" : "#888888");
				loadingProgress.Foreground = ThemeBrush(isLight ? "#0969B7" : "#0E70C0");
				loadingProgress.Background = ThemeBrush(isLight ? "#D9DEE7" : "#333333");
				errorText.Foreground = ThemeBrush(isLight ? "#B42318" : "#F44747");
				errorText.Background = ThemeBrush(isLight ? "#FFFFFF" : "#1E1E1E");
				errorText.BorderBrush = ThemeBrush(isLight ? "#C7CCD4" : "#3C3C3C");
			}

			if (Dispatcher.CheckAccess())
				Apply();
			else
				VisualStudioUiThread.Post(Apply);
		}

		private bool TryHandleThemePreference(string webMessageAsJson)
		{
			try
			{
				var message = JObject.Parse(webMessageAsJson);
				if (!string.Equals((string?)message["type"], "ligvs_theme_changed", StringComparison.Ordinal))
					return false;
				if ((int?)message["protocolVersion"] != 1)
					return false;

				var theme = UiThemePreferenceStore.Normalize((string?)message["theme"]);
				_themePreferences.Write(theme);
				ApplyLoadingTheme(theme);
				return true;
			}
			catch
			{
				return false;
			}
		}

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            CancelPendingUnloadDispose();
            _ = OnLoadedAsync();
        }

        private void OnUnloaded(object sender, RoutedEventArgs e)
        {
            CancelPendingUnloadDispose();
        }

        private async Task OnLoadedAsync()
        {
            if (_loaded)
            {
                await _sidecar.EnsureRunningAsync();
                return;
            }

            _loaded = true;

            try
            {
                SetStatus("WebView2를 초기화하는 중입니다...");
                await InitializeWebViewAsync();
            }
            catch (Exception ex)
            {
                ShowError($"초기화에 실패했습니다:\n{ex.Message}");
            }
        }

        private async Task InitializeWebViewAsync()
        {
            var assemblyDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
                ?? AppDomain.CurrentDomain.BaseDirectory;
            _assemblyDirectory = assemblyDirectory;
            _sidecar.AssemblyDirectory = assemblyDirectory;
            string? browserExecutableFolder = null;
            string? runtimeLabel = null;
            List<string> initializationFailures = new List<string>();

            try
            {
                SetStatus("WebView2 런타임을 준비하는 중입니다...");
                await System.Windows.Threading.Dispatcher.Yield();

                var runtimeCandidates = await Task.Run(() =>
                    WebView2RuntimeResolver.GetWebView2RuntimeCandidates(assemblyDirectory));
                foreach (var candidate in runtimeCandidates)
                {
                    initializationFailures.Add(
                        $"Candidate: {candidate.Label} => {candidate.BrowserExecutableFolder ?? "system"}");
                }

                var initialized = false;
                foreach (var candidate in runtimeCandidates)
                {
                    runtimeLabel = candidate.Label;
                    browserExecutableFolder = candidate.BrowserExecutableFolder;
                    var userDataFolder = WebView2RuntimeResolver.GetWebView2UserDataFolder(runtimeLabel, browserExecutableFolder);

                    try
                    {
                        SetStatus($"WebView2를 초기화하는 중입니다 ({runtimeLabel})...");
                        WebView2RuntimeResolver.EnsureWebView2RuntimeAvailable(browserExecutableFolder);
                        await CreateWebView2WithRetryAsync(runtimeLabel, browserExecutableFolder, userDataFolder);
                        initialized = true;
                        break;
                    }
                    catch (Exception ex)
                    {
                        initializationFailures.Add(
                            $"{runtimeLabel}: {ex.Message} (HRESULT 0x{ex.HResult:X8})");
                    }
                }

                if (!initialized)
                    throw new InvalidOperationException(
                        "No WebView2 runtime could initialize.\n" + string.Join("\n", initializationFailures));

                SetStatus("LIG VS 사이드카를 시작하는 중입니다...");
                var sidecarStarted = await _sidecar.EnsureRunningAsync();
                if (!sidecarStarted)
                {
                    ShowError(_sidecar.GetNotRunningMessage());
                    return;
                }

                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(WebviewBootstrapScript.Source);

                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                webView.CoreWebView2.Settings.IsScriptEnabled = true;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NavigationStarting += OnNavigationStarting;
                webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
                webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;

                var webAppDirectory = Path.Combine(
                    assemblyDirectory,
                    "WebApp");
                var htmlPath = Path.Combine(webAppDirectory, "index.html");

                if (File.Exists(htmlPath))
                {
                    webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                        "vscline.local",
                        webAppDirectory,
                        CoreWebView2HostResourceAccessKind.Allow);
                    webView.CoreWebView2.Navigate("https://vscline.local/index.html");
                }
                else
                    ShowError($"WebApp not found at:\n{htmlPath}\n\nEnsure WebApp files are included in the VSIX.");
            }
            catch (Exception ex)
            {
                ShowError(WebView2RuntimeResolver.BuildWebView2InitializationError(
                    ex,
                    assemblyDirectory,
                    runtimeLabel,
                    browserExecutableFolder,
                    initializationFailures));
            }
        }

        private async Task CreateWebView2WithRetryAsync(string runtimeLabel, string? browserExecutableFolder, string userDataFolder)
        {
            try
            {
                await CreateWebView2Async(runtimeLabel, browserExecutableFolder, userDataFolder);
            }
            catch (Exception ex) when (ShouldRetryWebView2Initialization(ex))
            {
                SetStatus("WebView2 프로필을 다시 만들고 재시도하는 중입니다...");
                ResetDirectory(userDataFolder);
                await CreateWebView2Async(runtimeLabel, browserExecutableFolder, userDataFolder);
            }
        }

        private async Task CreateWebView2Async(string runtimeLabel, string? browserExecutableFolder, string userDataFolder)
        {
            Directory.CreateDirectory(userDataFolder);
            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = string.Equals(
                    Environment.GetEnvironmentVariable("VSCLINE_WEBVIEW2_DISABLE_GPU"),
                    "1",
                    StringComparison.Ordinal)
                    ? "--disable-gpu"
                    : null
            };

            var env = await CoreWebView2Environment.CreateAsync(browserExecutableFolder, userDataFolder, options);
            await webView.EnsureCoreWebView2Async(env);
        }

        private static bool ShouldRetryWebView2Initialization(Exception ex)
        {
            return ex.HResult == unchecked((int)0x80131509) ||
                ex.Message.IndexOf("pipe", StringComparison.OrdinalIgnoreCase) >= 0 ||
                ex.Message.IndexOf("파이프", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static void ResetDirectory(string directory)
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, true);

            Directory.CreateDirectory(directory);
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (WebViewNavigationPolicy.ShouldOpenExternally(e.Uri))
            {
                e.Cancel = true;
                WebViewNavigationPolicy.TryOpenExternally(e.Uri);
                return;
            }

            _webviewMessages.SetReady(false);
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            if (WebViewNavigationPolicy.ShouldOpenExternally(e.Uri))
            {
                e.Handled = true;
                WebViewNavigationPolicy.TryOpenExternally(e.Uri);
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            _ = OnNavigationCompletedAsync(e);
        }

        private async Task OnNavigationCompletedAsync(CoreWebView2NavigationCompletedEventArgs e)
        {
            try
            {
                if (!e.IsSuccess)
                {
                    if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled)
                        return;

                    ShowError($"Page load failed: {e.WebErrorStatus}");
                    return;
                }

                _webviewMessages.SetReady(true);
                if (Dispatcher.CheckAccess())
                {
                    loadingPanel.Visibility = Visibility.Collapsed;
                    webView.Visibility = Visibility.Visible;
                }
                else
                {
                    await VisualStudioUiThread.InvokeAsync(() =>
                    {
                        loadingPanel.Visibility = Visibility.Collapsed;
                        webView.Visibility = Visibility.Visible;
                    });
                }

                await ReportBlankWebviewIfNeededAsync();
            }
            catch (Exception ex)
            {
                _sidecar.RecordError(ex);
                ShowError("WebView navigation handling failed:\n" + ex.Message);
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            _ = OnWebMessageReceivedAsync(e.WebMessageAsJson);
        }

        private async Task OnWebMessageReceivedAsync(string webMessageAsJson)
        {
            try
            {
                _lastWebMessageJson = webMessageAsJson;
                InteractionLog.Write("webview->host", "webview.message", webMessageAsJson);
				if (TryHandleThemePreference(webMessageAsJson))
					return;
                if (TryHandleHostDiagnostic(webMessageAsJson))
                    return;

                if (!_sidecar.IsRunning &&
                    WebviewGrpcFallback.IsPassiveStreamingSubscription(webMessageAsJson))
                    return;

                if (!_sidecar.IsRunning)
                {
                    var restarted = await _sidecar.EnsureRunningAsync();
                    if (!restarted)
                    {
                        await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, _sidecar.GetNotRunningMessage()));
                        return;
                    }
                }

                if (!_sidecar.IsRunning)
                {
                    await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, _sidecar.GetNotRunningMessage()));
                    return;
                }

                var handledBySidecar = await _sidecar.TryHandleWebviewMessageAsync(
                    webMessageAsJson,
                    SendToWebViewAsync,
                    CancellationToken.None);

                if (!handledBySidecar)
                    await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, "Unhandled WebView RPC. The VSIX wrapper only routes through the LIG VS SDK sidecar."));
            }
            catch (Exception ex)
            {
                _sidecar.RecordError(ex);
                if (WebviewGrpcFallback.IsPassiveStreamingSubscription(webMessageAsJson))
                    return;

                await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, ex.Message));
            }
        }

        public void Dispose()
        {
            if (_disposed)
                return;

            _disposed = true;
            Loaded -= OnLoaded;
            Unloaded -= OnUnloaded;
            DetachWebViewEventHandlers();
            CancelPendingUnloadDispose();
            _webviewMessages.Dispose();

            _sidecar.Dispose();
        }

        private void DetachWebViewEventHandlers()
        {
            try
            {
                if (webView.CoreWebView2 == null)
                    return;

                webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
                webView.CoreWebView2.NavigationStarting -= OnNavigationStarting;
                webView.CoreWebView2.NavigationCompleted -= OnNavigationCompleted;
                webView.CoreWebView2.NewWindowRequested -= OnNewWindowRequested;
            }
            catch
            {
            }
        }

        private void ScheduleUnloadDispose()
        {
            if (_disposed)
                return;

            CancelPendingUnloadDispose();
            var unloadDispose = new CancellationTokenSource();
            _pendingUnloadDispose = unloadDispose;

            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(3), unloadDispose.Token).ConfigureAwait(false);
                    if (unloadDispose.IsCancellationRequested)
                        return;

                    await VisualStudioUiThread.InvokeAsync(() =>
                    {
                        if (!IsLoaded)
                            _webviewMessages.ScheduleFlush();
                    });
                }
                catch (OperationCanceledException)
                {
                }
                catch
                {
                }
            });
        }

        private void CancelPendingUnloadDispose()
        {
            var pending = _pendingUnloadDispose;
            _pendingUnloadDispose = null;
            if (pending == null)
                return;

            try
            {
                pending.Cancel();
            }
            catch
            {
            }
            finally
            {
                pending.Dispose();
            }
        }

        private bool TryHandleHostDiagnostic(string rawJson)
        {
            try
            {
                var message = JObject.Parse(rawJson);
                if (!string.Equals(message.Value<string>("type"), "vscline.diagnostic", StringComparison.Ordinal))
                    return false;

                var kind = message.Value<string>("kind") ?? "script";
                var text = message.Value<string>("message") ?? "(no message)";
                var stack = message.Value<string>("stack") ?? "";
                ShowError("WebApp script failed:\n" + kind + ": " + text +
                    (string.IsNullOrWhiteSpace(stack) ? "" : "\n\n" + stack));
                return true;
            }
            catch
            {
                return false;
            }
        }

        private async Task ReportBlankWebviewIfNeededAsync()
        {
            try
            {
                await Task.Delay(10000).ConfigureAwait(true);
                if (webView.CoreWebView2 == null)
                    return;

                var result = await webView.CoreWebView2.ExecuteScriptAsync(@"
(function () {
    var root = document.getElementById('root');
    var bodyText = (document.body && document.body.innerText || '').trim();
    var rootHtml = root && root.innerHTML ? root.innerHTML.trim() : '';
    var diagnostics = window.__vsClineDiagnostics || {};
    var scripts = Array.prototype.map.call(document.scripts || [], function (script) {
        return script.src || '[inline]';
    });
    var stylesheets = Array.prototype.map.call(document.styleSheets || [], function (sheet) {
        try { return sheet.href || '[inline]'; }
        catch (_) { return '[inaccessible]'; }
    });
    return JSON.stringify({
        title: document.title,
        location: location.href,
        readyState: document.readyState,
        scriptCount: document.scripts.length,
        stylesheetCount: document.styleSheets.length,
        scripts: scripts,
        stylesheets: stylesheets,
        rootExists: !!root,
        rootHtmlLength: rootHtml.length,
        rootHtmlPreview: rootHtml.slice(0, 2000),
        bodyTextLength: bodyText.length,
        bodyText: bodyText.slice(0, 2000),
        userAgent: navigator.userAgent,
        diagnostics: diagnostics
    });
})()");
                var json = JsonConvert.DeserializeObject<string>(result) ?? "{}";
                var state = JObject.Parse(json);
                if (state.Value<bool?>("rootExists") == true &&
                    state.Value<int?>("rootHtmlLength") == 0 &&
                    state.Value<int?>("bodyTextLength") == 0)
                {
                    ShowError(HostDiagnosticReport.Create(
                        "WebApp loaded but rendered no UI.",
                        "This usually means the LIG VS WebApp did not receive its initial StateService hydration response.",
                        state,
                        CreateDiagnosticContext()));
                }
            }
            catch (Exception ex)
            {
                ShowError("WebApp diagnostics failed:\n" + ex.Message);
            }
        }

        public Task SendToWebViewAsync(object payload)
        {
            try
            {
                var json = JsonConvert.SerializeObject(payload);
                InteractionLog.Write("host->webview", "webview.postMessage", json);
                _webviewMessages.Enqueue(json);
            }
            catch (Exception ex)
            {
                InteractionLog.Write("host", "webview.message.enqueueFailed", new { error = ex.Message });
            }

            return Task.CompletedTask;
        }

        private void SetStatus(string message)
        {
            if (Dispatcher.CheckAccess())
            {
                statusText.Text = message;
                return;
            }

            VisualStudioUiThread.Post(() => statusText.Text = message);
        }

        private void ShowError(string message)
        {
            void ApplyError()
            {
                var detailedMessage = message.IndexOf("=== Snapshot ===", StringComparison.Ordinal) >= 0
                    ? message
                    : HostDiagnosticReport.Create(message, null, null, CreateDiagnosticContext());
                loadingPanel.Visibility = Visibility.Collapsed;
                webView.Visibility = Visibility.Collapsed;
                errorText.Text = detailedMessage;
                errorText.Visibility = Visibility.Visible;
                HostDiagnosticReport.WriteSnapshot(detailedMessage);
            }

            if (Dispatcher.CheckAccess())
                ApplyError();
            else
                VisualStudioUiThread.Post(ApplyError);
        }

        private HostDiagnosticContext CreateDiagnosticContext()
        {
            return new HostDiagnosticContext
            {
                AssemblyDirectory = _assemblyDirectory,
                WebviewReady = _webviewMessages.IsReady,
                Loaded = _loaded,
                SidecarRunning = _sidecar.IsRunning,
                LastSidecarError = _sidecar.LastError,
                LastWebMessageJson = _lastWebMessageJson
            };
        }

    }
}
