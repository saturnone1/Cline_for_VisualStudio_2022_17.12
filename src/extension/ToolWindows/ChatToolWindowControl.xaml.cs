using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host;
using VsClineAgent.Host.Generated;
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
        private readonly WebViewLoadingPresenter _loadingPresenter;
        private readonly ToolWindowLifetime _lifetime;
		private readonly CancellationTokenSource _diagnosticCancellation = new CancellationTokenSource();
        private bool _loaded;
        private bool _initializing;
        private int _webviewHydrated;
        private bool _initialized;
        internal bool IsDisposed => _lifetime.IsDisposed;

        public ChatToolWindowControl()
        {
            InitializeComponent();
			_themePreferences = new UiThemePreferenceStore();
			_webviewMessages = new WebviewMessageQueue(() => webView.CoreWebView2);
			_loadingPresenter = new WebViewLoadingPresenter(this, loadingLogoImage, loadingTitleText, loadingBrandText, statusText, loadingProgress, errorText);
			_loadingPresenter.ApplyTheme(_themePreferences.Read());
			_loadingPresenter.InitializeLogo(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? AppDomain.CurrentDomain.BaseDirectory);
			_loadingPresenter.StartAnimation();
            _sidecar = new SidecarLifecycle(
                new VsEditorService(),
                new VsCommandExecutionService(new VisualStudioOutputPaneWriter()),
                SetStatus);
			_sidecar.ReadyGenerationChanged += OnSidecarReadyGenerationChanged;
			_sidecar.TransportUnavailable += OnSidecarTransportUnavailable;
            Loaded += OnLoaded;
            Unloaded += OnUnloaded;
            _lifetime = new ToolWindowLifetime(
                () =>
                {
                    Loaded -= OnLoaded;
                    Unloaded -= OnUnloaded;
					_sidecar.ReadyGenerationChanged -= OnSidecarReadyGenerationChanged;
					_sidecar.TransportUnavailable -= OnSidecarTransportUnavailable;
                    DetachWebViewEventHandlers();
                },
                () => _webviewMessages.Dispose(),
				() => { _diagnosticCancellation.Cancel(); _diagnosticCancellation.Dispose(); },
                () => _loadingPresenter.StopAnimation(),
                () => _sidecar.Dispose());
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
				_loadingPresenter.ApplyTheme(theme);
				return true;
			}
			catch
			{
				return false;
			}
		}

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
	            _loaded = true;
	            _ = OnLoadedAsync();
        }

		private void OnSidecarReadyGenerationChanged(int generation)
		{
			_ = SendToWebViewAsync(new
			{
				protocol_version = WebviewRpcContract.ProtocolVersion,
				type = "vscline_transport_reset",
				generation
			});
		}

		private void OnSidecarTransportUnavailable(int generation)
		{
			_ = SendToWebViewAsync(new
			{
				protocol_version = WebviewRpcContract.ProtocolVersion,
				type = "vscline_transport_unavailable",
				generation
			});
		}

        private void OnUnloaded(object sender, RoutedEventArgs e)
        {
	            _loaded = false;
	            _webviewMessages.ScheduleFlush();
        }

        private async Task OnLoadedAsync()
        {
            if (_initialized)
            {
                await _sidecar.EnsureRunningAsync(_diagnosticCancellation.Token);
                return;
            }

            if (_initializing)
                return;

            _initializing = true;

            try
            {
                SetStatus("WebView2를 초기화하는 중입니다...");
                _initialized = await InitializeWebViewAsync();
            }
            catch (Exception ex)
            {
                _initialized = false;
                ShowError($"초기화에 실패했습니다:\n{ex.Message}");
            }
            finally
            {
                _initializing = false;
            }
        }

        private async Task<bool> InitializeWebViewAsync()
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
                SetStatus("LIG VS 사이드카를 준비하는 중입니다. 처음 실행하거나 업데이트한 직후에는 의존성 구성에 시간이 걸릴 수 있습니다...");
                var sidecarStarted = await _sidecar.EnsureRunningAsync(_diagnosticCancellation.Token);
                if (!sidecarStarted)
                {
                    ShowError(_sidecar.GetNotRunningMessage());
                    return false;
                }

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
                        WebView2RuntimeResolver.CleanupInactiveUserDataFolders(userDataFolder);
                        initialized = true;
                        break;
                    }
                    catch (Exception ex)
                    {
                        WebView2RuntimeResolver.RemoveFailedUserDataFolder(userDataFolder);
                        initializationFailures.Add(
                            $"{runtimeLabel}: {ex.Message} (HRESULT 0x{ex.HResult:X8})");
                    }
                }

                if (!initialized)
                    throw new InvalidOperationException(
                        "No WebView2 runtime could initialize.\n" + string.Join("\n", initializationFailures));

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
                    return true;
                }
                else
                {
                    ShowError($"WebApp not found at:\n{htmlPath}\n\nEnsure WebApp files are included in the VSIX.");
                    return false;
                }
            }
            catch (Exception ex)
            {
                ShowError(WebView2RuntimeResolver.BuildWebView2InitializationError(
                    ex,
                    assemblyDirectory,
                    runtimeLabel,
                    browserExecutableFolder,
                    initializationFailures));
                return false;
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
                ex.HResult == unchecked((int)0x80131622) ||
                ex.Message.IndexOf("pipe", StringComparison.OrdinalIgnoreCase) >= 0 ||
                ex.Message.IndexOf("파이프", StringComparison.OrdinalIgnoreCase) >= 0 ||
                ex.Message.IndexOf("semaphore", StringComparison.OrdinalIgnoreCase) >= 0 ||
                ex.Message.IndexOf("세마포", StringComparison.OrdinalIgnoreCase) >= 0;
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
            Volatile.Write(ref _webviewHydrated, 0);
			_loadingPresenter.StartAnimation();
			SetStatus("LIG VS를 준비하는 중입니다...");
			loadingPanel.Visibility = Visibility.Visible;
			webView.Visibility = Visibility.Collapsed;
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
				SetStatus("홈 화면을 준비하는 중입니다...");
				if (Volatile.Read(ref _webviewHydrated) != 0)
					await RevealHydratedWebViewAsync();

				_ = _sidecar.WarmSdkAsync(_diagnosticCancellation.Token);
				await ReportBlankWebviewIfNeededAsync(_diagnosticCancellation.Token);
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
                if (TryHandleWebViewLifecycle(webMessageAsJson))
                    return;
                if (TryHandleHostDiagnostic(webMessageAsJson))
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
                    _diagnosticCancellation.Token);

                if (!handledBySidecar)
                    await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, "Unhandled WebView RPC. The VSIX wrapper only routes through the LIG VS SDK sidecar."));
            }
            catch (Exception ex)
            {
                _sidecar.RecordError(ex);
                await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, ex.Message));
            }
        }

        public void Dispose()
        {
            _lifetime.Dispose();
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

        private bool TryHandleWebViewLifecycle(string rawJson)
        {
            if (!WebViewLifecycleMessage.IsHydrated(rawJson))
                return false;

            Volatile.Write(ref _webviewHydrated, 1);
            _ = RevealHydratedWebViewAsync();
            return true;
        }

        private async Task RevealHydratedWebViewAsync()
        {
            void Reveal()
            {
				_loadingPresenter.StopAnimation();
                loadingPanel.Visibility = Visibility.Collapsed;
                webView.Visibility = Visibility.Visible;
            }

            if (Dispatcher.CheckAccess()) Reveal();
            else await VisualStudioUiThread.InvokeAsync(Reveal);
        }

		private async Task ReportBlankWebviewIfNeededAsync(CancellationToken cancellationToken)
        {
            try
            {
				await Task.Delay(_loadingPresenter.BlankDiagnosticDelay, cancellationToken).ConfigureAwait(true);
				cancellationToken.ThrowIfCancellationRequested();
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
                if (Volatile.Read(ref _webviewHydrated) == 0)
                {
                    ShowError(HostDiagnosticReport.Create(
                        "WebApp loaded but initial state hydration did not complete.",
                        "The native loading screen remained visible because the WebApp did not confirm its initial StateService snapshot.",
                        state,
                        CreateDiagnosticContext()));
                    return;
                }
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
			catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
			{
				// The ToolWindow was closed before the delayed diagnostic was needed.
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
	            _loadingPresenter.SetStatus(message);
	        }

        private void ShowError(string message)
        {
            void ApplyError()
            {
				_loadingPresenter.StopAnimation();
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
                _ = VisualStudioUiThread.PostAsync(ApplyError);
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
