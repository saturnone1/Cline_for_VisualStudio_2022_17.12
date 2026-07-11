using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
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

        private SidecarProcess? _sidecarProcess;
        private readonly VsEditorService _editorService;
        private readonly VsCommandExecutionService _commandExecutionService;
        private readonly SemaphoreSlim _sidecarStartLock = new SemaphoreSlim(1, 1);
        private string? _assemblyDirectory;
        private string? _lastSidecarError;
        private string? _lastWebMessageJson;
        private readonly WebviewMessageQueue _webviewMessages;
        private bool _loaded;
        private bool _disposed;
        private CancellationTokenSource? _pendingUnloadDispose;
		private const string LightTheme = "light";
		private const string DarkTheme = "dark";

        public ChatToolWindowControl()
        {
            InitializeComponent();
			_webviewMessages = new WebviewMessageQueue(Dispatcher, () => webView.CoreWebView2);
			ApplyLoadingTheme(ReadPersistedTheme());
            InitializeLoadingLogo();
            _editorService = new VsEditorService();
            _commandExecutionService = new VsCommandExecutionService();
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

		private static string GetThemePreferencePath()
		{
			var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
			return Path.Combine(localAppData, "VsClineAgent", "ui-theme.txt");
		}

		private static string ReadPersistedTheme()
		{
			try
			{
				return string.Equals(File.ReadAllText(GetThemePreferencePath()).Trim(), LightTheme, StringComparison.OrdinalIgnoreCase)
					? LightTheme
					: DarkTheme;
			}
			catch
			{
				return DarkTheme;
			}
		}

		private static void PersistTheme(string theme)
		{
			try
			{
				var themePath = GetThemePreferencePath();
				Directory.CreateDirectory(Path.GetDirectoryName(themePath)!);
				File.WriteAllText(themePath, theme == LightTheme ? LightTheme : DarkTheme);
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
				var isLight = string.Equals(theme, LightTheme, StringComparison.OrdinalIgnoreCase);
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
				Dispatcher.BeginInvoke(new Action(Apply));
		}

		private bool TryHandleThemePreference(string webMessageAsJson)
		{
			try
			{
				var message = JObject.Parse(webMessageAsJson);
				if (!string.Equals((string?)message["type"], "ligvs_theme_changed", StringComparison.Ordinal))
					return false;

				var theme = string.Equals((string?)message["theme"], LightTheme, StringComparison.OrdinalIgnoreCase)
					? LightTheme
					: DarkTheme;
				PersistTheme(theme);
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
                await TryEnsureSidecarRunningAsync();
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
                await TryEnsureSidecarRunningAsync();

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
                AdditionalBrowserArguments = "--disable-gpu"
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
            if (ShouldOpenOutsideWebView(e.Uri))
            {
                e.Cancel = true;
                OpenExternalBrowser(e.Uri);
                return;
            }

            _webviewMessages.SetReady(false);
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            if (ShouldOpenOutsideWebView(e.Uri))
            {
                e.Handled = true;
                OpenExternalBrowser(e.Uri);
            }
        }

        private static bool ShouldOpenOutsideWebView(string? uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
                return false;

            if (string.Equals(parsed.Host, "vscline.local", StringComparison.OrdinalIgnoreCase))
                return false;

            return IsExternalBrowserScheme(parsed.Scheme);
        }

        private static bool IsExternalBrowserScheme(string scheme)
        {
            return string.Equals(scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(scheme, Uri.UriSchemeMailto, StringComparison.OrdinalIgnoreCase);
        }

        private static void OpenExternalBrowser(string uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed) ||
                !IsExternalBrowserScheme(parsed.Scheme))
            {
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo(parsed.AbsoluteUri)
                {
                    UseShellExecute = true
                });
            }
            catch
            {
                // Keep the embedded app in place even when Windows cannot resolve the external URL.
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
                    await Dispatcher.InvokeAsync(() =>
                    {
                        loadingPanel.Visibility = Visibility.Collapsed;
                        webView.Visibility = Visibility.Visible;
                    });
                }

                await ReportBlankWebviewIfNeededAsync();
            }
            catch (Exception ex)
            {
                _lastSidecarError = ex.ToString();
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

                if ((_sidecarProcess == null || !_sidecarProcess.IsRunning) &&
                    WebviewGrpcFallback.IsPassiveStreamingSubscription(webMessageAsJson))
                    return;

                if (_sidecarProcess == null || !_sidecarProcess.IsRunning)
                {
                    var restarted = await TryEnsureSidecarRunningAsync();
                    if (!restarted)
                    {
                        await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, GetSidecarNotRunningMessage()));
                        return;
                    }
                }

                var sidecarProcess = _sidecarProcess;
                if (sidecarProcess == null || !sidecarProcess.IsRunning)
                {
                    await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, GetSidecarNotRunningMessage()));
                    return;
                }

                var handledBySidecar = await sidecarProcess.TryHandleWebviewMessageAsync(
                    webMessageAsJson,
                    SendToWebViewAsync,
                    CancellationToken.None);

                if (!handledBySidecar)
                    await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, "Unhandled WebView RPC. The VSIX wrapper only routes through the LIG VS SDK sidecar."));
            }
            catch (Exception ex)
            {
                _lastSidecarError = ex.ToString();
                if (WebviewGrpcFallback.IsPassiveStreamingSubscription(webMessageAsJson))
                    return;

                await SendToWebViewAsync(WebviewGrpcFallback.CreateErrorResponse(webMessageAsJson, ex.Message));
            }
        }

        private async Task<bool> TryEnsureSidecarRunningAsync()
        {
            await _sidecarStartLock.WaitAsync();
            try
            {
                if (_sidecarProcess != null && _sidecarProcess.IsRunning)
                    return true;

                var assemblyDirectory = _assemblyDirectory ??
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ??
                    AppDomain.CurrentDomain.BaseDirectory;

                DisposeSidecarProcessQuietly();
                _sidecarProcess = new SidecarProcess(assemblyDirectory, _editorService, _commandExecutionService);
                SetStatus("LIG VS 사이드카 런타임을 준비하는 중입니다...");
                await System.Windows.Threading.Dispatcher.Yield();

                var sidecarProcess = _sidecarProcess
                    ?? throw new InvalidOperationException("Cline sidecar process was not created.");
                var status = await Task.Run(() =>
                    sidecarProcess.EnsureStartedAsync(CancellationToken.None));
                _lastSidecarError = null;
                SetStatus($"LIG VS 사이드카: {status}");
                return _sidecarProcess != null && _sidecarProcess.IsRunning;
            }
            catch (Exception ex)
            {
                _lastSidecarError = "LIG VS sidecar failed to start: " + ex.Message;
                SetStatus(_lastSidecarError);
                return false;
            }
            finally
            {
                _sidecarStartLock.Release();
            }
        }

        private string GetSidecarNotRunningMessage()
        {
            return string.IsNullOrWhiteSpace(_lastSidecarError)
                ? "LIG VS SDK sidecar is not running."
                : _lastSidecarError!;
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

            DisposeSidecarProcessQuietly();

            try
            {
                _commandExecutionService.Dispose();
            }
            catch
            {
            }
        }

        private void DisposeSidecarProcessQuietly()
        {
            try
            {
                _sidecarProcess?.Dispose();
            }
            catch
            {
            }
            finally
            {
                _sidecarProcess = null;
            }
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

                    await Dispatcher.InvokeAsync(() =>
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

        private static string BuildInitialExtensionStateJson()
        {
            var providerId = Environment.GetEnvironmentVariable("CLINE_PROVIDER_ID") ?? "ollama";
            var baseUrl = Environment.GetEnvironmentVariable("CLINE_BASE_URL") ?? "";
            var modelId = Environment.GetEnvironmentVariable("CLINE_MODEL_ID") ?? "";
            var apiKey =
                Environment.GetEnvironmentVariable("CLINE_API_KEY") ??
                Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") ??
                "";

            var state = new JObject
            {
                ["version"] = "vs2022-17.12-sdk-port",
                ["apiConfiguration"] = new JObject
                {
                    ["actModeApiProvider"] = providerId,
                    ["planModeApiProvider"] = providerId,
                    ["apiKey"] = apiKey,
                    ["openRouterApiKey"] = "",
                    ["openAiApiKey"] = apiKey,
                    ["ollamaApiKey"] = Environment.GetEnvironmentVariable("OLLAMA_API_KEY") ?? "",
                    ["geminiApiKey"] = "",
                    ["anthropicBaseUrl"] = "",
                    ["openAiBaseUrl"] = baseUrl,
                    ["ollamaBaseUrl"] = string.IsNullOrWhiteSpace(baseUrl) ? "http://localhost:11434" : baseUrl,
                    ["geminiBaseUrl"] = "",
                    ["actModeOpenAiBaseUrl"] = baseUrl,
                    ["planModeOpenAiBaseUrl"] = baseUrl,
                    ["actModeApiModelId"] = string.IsNullOrWhiteSpace(modelId) ? "claude-sonnet-4-6" : modelId,
                    ["planModeApiModelId"] = string.IsNullOrWhiteSpace(modelId) ? "claude-sonnet-4-6" : modelId,
                    ["actModeOpenAiModelId"] = string.IsNullOrWhiteSpace(modelId) ? "claude-sonnet-4-6" : modelId,
                    ["planModeOpenAiModelId"] = string.IsNullOrWhiteSpace(modelId) ? "claude-sonnet-4-6" : modelId,
                    ["actModeOllamaModelId"] = modelId,
                    ["planModeOllamaModelId"] = modelId
                },
                ["clineMessages"] = new JArray(),
                ["taskHistory"] = new JArray(),
                ["shouldShowAnnouncement"] = false,
                ["autoApprovalSettings"] = new JObject
                {
                    ["version"] = 1,
                    ["enabled"] = false,
                    ["favorites"] = new JArray(),
                    ["maxRequests"] = 20,
                    ["actions"] = new JObject()
                },
                ["browserSettings"] = new JObject
                {
                    ["viewport"] = new JObject { ["width"] = 900, ["height"] = 600 },
                    ["remoteBrowserEnabled"] = false,
                    ["disableToolUse"] = true
                },
                ["focusChainSettings"] = new JObject { ["enabled"] = false, ["remindClineInterval"] = 6 },
                ["preferredLanguage"] = "English",
                ["mode"] = "act",
                ["platform"] = "win32",
                ["environment"] = "production",
                ["telemetrySetting"] = "unset",
                ["distinctId"] = "vsclineagent-visualstudio-sdk",
                ["planActSeparateModelsSetting"] = true,
                ["enableCheckpointsSetting"] = true,
                ["checkpointManagerErrorMessage"] = null,
                ["mcpDisplayMode"] = "plain",
                ["globalClineRulesToggles"] = new JObject(),
                ["localClineRulesToggles"] = new JObject(),
                ["localCursorRulesToggles"] = new JObject(),
                ["localWindsurfRulesToggles"] = new JObject(),
                ["localAgentsRulesToggles"] = new JObject(),
                ["localWorkflowToggles"] = new JObject(),
                ["globalWorkflowToggles"] = new JObject(),
                ["shellIntegrationTimeout"] = 4000,
                ["terminalReuseEnabled"] = true,
                ["vscodeTerminalExecutionMode"] = "vscodeTerminal",
                ["terminalOutputLineLimit"] = 500,
                ["maxConsecutiveMistakes"] = 3,
                ["defaultTerminalProfile"] = "visual-studio-command-host",
                ["isNewUser"] = false,
                ["welcomeViewCompleted"] = true,
                ["onboardingModels"] = null,
                ["mcpResponsesCollapsed"] = false,
                ["strictPlanModeEnabled"] = false,
                ["yoloModeToggled"] = false,
                ["customPrompt"] = null,
                ["useAutoCondense"] = false,
                ["subagentsEnabled"] = false,
                ["clineWebToolsEnabled"] = new JObject { ["user"] = false, ["featureFlag"] = false },
                ["worktreesEnabled"] = new JObject { ["user"] = true, ["featureFlag"] = false },
                ["favoritedModelIds"] = new JArray(),
                ["lastDismissedInfoBannerVersion"] = 0,
                ["lastDismissedModelBannerVersion"] = 0,
                ["lastDismissedCliBannerVersion"] = 0,
                ["optOutOfRemoteConfig"] = true,
                ["remoteConfigSettings"] = new JObject(),
                ["backgroundCommandRunning"] = false,
                ["backgroundEditEnabled"] = false,
                ["doubleCheckCompletionEnabled"] = false,
                ["lazyTeammateModeEnabled"] = false,
                ["showFeatureTips"] = false,
                ["globalSkillsToggles"] = new JObject(),
                ["localSkillsToggles"] = new JObject(),
                ["openAiCodexIsAuthenticated"] = false,
                ["workspaceRoots"] = new JArray(),
                ["primaryRootIndex"] = 0,
                ["isMultiRootWorkspace"] = false,
                ["multiRootSetting"] = new JObject { ["user"] = false, ["featureFlag"] = false },
                ["hooksEnabled"] = false,
                ["nativeToolCallSetting"] = false,
                ["enableParallelToolCalling"] = false,
                ["currentTaskItem"] = null,
                ["vsClineSdkCoverage"] = new JObject
                {
                    ["mode"] = "sdk-wrapper",
                    ["sdkPackage"] = "@cline/sdk",
                    ["sdkVersion"] = "0.0.42",
                    ["status"] = "ready"
                }
            };

            ApplyPersistedState(state);
            return state.ToString(Formatting.None);
        }

        private static void ApplyPersistedState(JObject state)
        {
            try
            {
                var settingsPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "VsClineAgent",
                    "settings.json");
                if (!File.Exists(settingsPath))
                    return;

                var persisted = JObject.Parse(File.ReadAllText(settingsPath));
                MergeObject(state["apiConfiguration"] as JObject, persisted["apiConfiguration"] as JObject);
                MergeObject(state["autoApprovalSettings"] as JObject, persisted["autoApprovalSettings"] as JObject);

                var mode = persisted.Value<string>("mode");
                if (string.Equals(mode, "plan", StringComparison.Ordinal) ||
                    string.Equals(mode, "act", StringComparison.Ordinal))
                    state["mode"] = mode;

                var separateModels = persisted.Value<bool?>("planActSeparateModelsSetting");
                if (separateModels.HasValue)
                    state["planActSeparateModelsSetting"] = separateModels.Value;

                foreach (var key in new[]
                {
                    "enableCheckpointsSetting",
                    "mcpResponsesCollapsed",
                    "strictPlanModeEnabled",
                    "yoloModeToggled",
                    "useAutoCondense",
                    "subagentsEnabled",
                    "scheduledAgentsEnabled",
                    "backgroundEditEnabled",
                    "doubleCheckCompletionEnabled",
                    "lazyTeammateModeEnabled",
                    "showFeatureTips",
                    "hooksEnabled",
                    "nativeToolCallSetting",
                    "enableParallelToolCalling"
                })
                {
                    var value = persisted.Value<bool?>(key);
                    if (value.HasValue)
                        state[key] = value.Value;
                }

                var preferredLanguage = persisted.Value<string>("preferredLanguage");
                if (!string.IsNullOrWhiteSpace(preferredLanguage))
                    state["preferredLanguage"] = preferredLanguage;

                var uiLanguage = persisted.Value<string>("uiLanguage");
                if (string.Equals(uiLanguage, "en", StringComparison.Ordinal) ||
                    string.Equals(uiLanguage, "ko", StringComparison.Ordinal))
                    state["uiLanguage"] = uiLanguage;

                var mcpDisplayMode = persisted.Value<string>("mcpDisplayMode");
                if (string.Equals(mcpDisplayMode, "rich", StringComparison.Ordinal) ||
                    string.Equals(mcpDisplayMode, "plain", StringComparison.Ordinal) ||
                    string.Equals(mcpDisplayMode, "markdown", StringComparison.Ordinal))
                    state["mcpDisplayMode"] = mcpDisplayMode;

                var customPrompt = persisted.Value<string>("customPrompt");
                if (customPrompt != null)
                    state["customPrompt"] = customPrompt;
            }
            catch
            {
            }
        }

        private static void MergeObject(JObject? target, JObject? source)
        {
            if (target == null || source == null)
                return;

            foreach (var property in source.Properties())
            {
                if (property.Value.Type != JTokenType.Null &&
                    property.Value.Type != JTokenType.Undefined)
                    target[property.Name] = property.Value.DeepClone();
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
                    ShowError(BuildDetailedDiagnostic(
                        "WebApp loaded but rendered no UI.",
                        "This usually means the LIG VS WebApp did not receive its initial StateService hydration response.",
                        state));
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
            catch { }

            return Task.CompletedTask;
        }

        private void SetStatus(string message)
        {
            if (Dispatcher.CheckAccess())
            {
                statusText.Text = message;
                return;
            }

            Dispatcher.BeginInvoke(new Action(() => statusText.Text = message));
        }

        private void ShowError(string message)
        {
            void ApplyError()
            {
                var detailedMessage = message.IndexOf("=== Snapshot ===", StringComparison.Ordinal) >= 0
                    ? message
                    : BuildDetailedDiagnostic(message, null, null);
                loadingPanel.Visibility = Visibility.Collapsed;
                webView.Visibility = Visibility.Collapsed;
                errorText.Text = detailedMessage;
                errorText.Visibility = Visibility.Visible;
                WriteDiagnosticSnapshot(detailedMessage);
            }

            if (Dispatcher.CheckAccess())
                ApplyError();
            else
                Dispatcher.BeginInvoke(new Action(ApplyError));
        }

        private string BuildDetailedDiagnostic(string summary, string? hint, JObject? webState)
        {
            var builder = new StringBuilder();
            builder.AppendLine(summary);
            builder.AppendLine();
            builder.AppendLine("=== Snapshot ===");
            builder.AppendLine("Time: " + DateTime.Now.ToString("O"));
            builder.AppendLine("VsClineAgent assembly: " + GetDisplayAssemblyVersion(Assembly.GetExecutingAssembly()));
            builder.AppendLine("Assembly location: " + Assembly.GetExecutingAssembly().Location);
            builder.AppendLine("Assembly directory: " + (_assemblyDirectory ?? "(unset)"));
            builder.AppendLine("WebView ready: " + _webviewMessages.IsReady);
            builder.AppendLine("Loaded: " + _loaded);
            builder.AppendLine("Sidecar running: " + (_sidecarProcess != null && _sidecarProcess.IsRunning));
            builder.AppendLine("Last sidecar error: " + (_lastSidecarError ?? "(none)"));
            builder.AppendLine();

            if (webState != null)
            {
                builder.AppendLine("=== WebView State ===");
                builder.AppendLine(webState.ToString(Formatting.Indented));
                builder.AppendLine();
            }

            builder.AppendLine("=== Last Web Message From WebApp ===");
            builder.AppendLine(PrettyJsonOrRaw(_lastWebMessageJson));
            builder.AppendLine();

            builder.AppendLine("=== Sidecar Log Tail ===");
            builder.AppendLine(ReadSidecarLogTail());
            builder.AppendLine();

            builder.AppendLine("=== Node Processes ===");
            builder.AppendLine(ReadNodeProcesses());
            builder.AppendLine();

            builder.AppendLine("=== Local Runtime Files ===");
            builder.AppendLine(ReadRuntimeSummary());
            builder.AppendLine();

            if (!string.IsNullOrWhiteSpace(hint))
            {
                builder.AppendLine("=== Hint ===");
                builder.AppendLine(hint);
                builder.AppendLine();
            }

            builder.AppendLine("You can select this text with Ctrl+A and copy it with Ctrl+C.");
            return builder.ToString();
        }

        private static string GetDisplayAssemblyVersion(Assembly assembly)
        {
            var informationalVersion = assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                ?.InformationalVersion;

            if (!string.IsNullOrWhiteSpace(informationalVersion))
                return informationalVersion!;

            return assembly.GetName().Version?.ToString() ?? "unknown";
        }

        private static string PrettyJsonOrRaw(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return "(none)";

            try
            {
                return JToken.Parse(value!).ToString(Formatting.Indented);
            }
            catch
            {
                return value!;
            }
        }

        private static string ReadSidecarLogTail()
        {
            try
            {
                var path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "VsClineAgent",
                    "logs",
                    "sidecar-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
                if (!File.Exists(path))
                    return "No sidecar log found at " + path;

                var lines = File.ReadAllLines(path);
                return "Path: " + path + Environment.NewLine +
                       string.Join(Environment.NewLine, lines.Skip(Math.Max(0, lines.Length - 200)));
            }
            catch (Exception ex)
            {
                return "Failed to read sidecar log: " + ex;
            }
        }

        private static string ReadNodeProcesses()
        {
            try
            {
                var builder = new StringBuilder();
                foreach (var process in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        builder.AppendLine("PID: " + process.Id);
                        builder.AppendLine("Path: " + SafeRead(() => process.MainModule?.FileName ?? "(unknown)"));
                        builder.AppendLine("Started: " + SafeRead(() => process.StartTime.ToString("O")));
                        builder.AppendLine();
                    }
                    catch (Exception ex)
                    {
                        builder.AppendLine("PID: " + process.Id + " (" + ex.Message + ")");
                    }
                }

                return builder.Length == 0 ? "(none)" : builder.ToString();
            }
            catch (Exception ex)
            {
                return "Failed to enumerate node processes: " + ex;
            }
        }

        private static string ReadRuntimeSummary()
        {
            try
            {
                var roots = new[]
                {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VsClineAgent", "Sidecar", "1.0.0"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VsClineAgent", "logs")
                };
                var builder = new StringBuilder();
                foreach (var root in roots)
                {
                    builder.AppendLine(root);
                    if (!Directory.Exists(root))
                    {
                        builder.AppendLine("  (missing)");
                        continue;
                    }

                    foreach (var entry in Directory.EnumerateFileSystemEntries(root).Take(80))
                    {
                        var info = new FileInfo(entry);
                        builder.AppendLine("  " + Path.GetFileName(entry) + " | " +
                            (Directory.Exists(entry) ? "dir" : info.Length.ToString()) + " | " +
                            info.LastWriteTime.ToString("O"));
                    }
                }

                return builder.ToString();
            }
            catch (Exception ex)
            {
                return "Failed to read runtime summary: " + ex;
            }
        }

        private static string SafeRead(Func<string> read)
        {
            try
            {
                return read();
            }
            catch (Exception ex)
            {
                return "(" + ex.Message + ")";
            }
        }

        private static void WriteDiagnosticSnapshot(string message)
        {
            try
            {
                var directory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "VsClineAgent",
                    "logs");
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, "diagnostic-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
                File.WriteAllText(path, message, Encoding.UTF8);
            }
            catch
            {
            }
        }
    }
}
