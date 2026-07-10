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
        private bool _webViewReady;
        private bool _loaded;
        private bool _disposed;
        private CancellationTokenSource? _pendingUnloadDispose;
        private readonly object _webViewPostLock = new object();
        private readonly Queue<string> _pendingWebViewMessages = new Queue<string>();
        private bool _webViewPostFlushScheduled;
        private const int MaxPendingWebViewMessages = 1000;
		private const string LightTheme = "light";
		private const string DarkTheme = "dark";

        public ChatToolWindowControl()
        {
            InitializeComponent();
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
                    GetWebView2RuntimeCandidates(assemblyDirectory));
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
                    var userDataFolder = GetWebView2UserDataFolder(runtimeLabel, browserExecutableFolder);

                    try
                    {
                        SetStatus($"WebView2를 초기화하는 중입니다 ({runtimeLabel})...");
                        EnsureWebView2RuntimeAvailable(browserExecutableFolder);
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

                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
(function () {
    if (window.__vsClineAcquireVsCodeApi) {
        return;
    }

    function installThemeShim() {
        try {
            if (!document.documentElement) {
                return false;
            }

            function getThemeMode() {
                try {
                    return window.localStorage && window.localStorage.getItem('ligVsTheme') === 'light'
                        ? 'light'
                        : 'dark';
                } catch (_) {
                    return 'dark';
                }
            }

            function applyThemeMode(theme) {
                const mode = theme === 'light' ? 'light' : getThemeMode();
                const isDark = mode !== 'light';
                document.documentElement.classList.toggle('dark', isDark);
                document.documentElement.dataset.vsclineTheme = mode;
                if (document.body) {
                    document.body.classList.toggle('dark', isDark);
                    document.body.dataset.vsclineTheme = mode;
                }
                try {
                    window.chrome && window.chrome.webview && window.chrome.webview.postMessage({
                        type: 'ligvs_theme_changed',
                        theme: mode
                    });
                } catch (_) {
                }
            }

            applyThemeMode();

            if (document.getElementById('vscline-vscode-theme-shim')) {
                return true;
            }

            const themeStyle = document.createElement('style');
            themeStyle.id = 'vscline-vscode-theme-shim';
            themeStyle.textContent = `
:root {
    color-scheme: dark;
    --vscode-font-family: 'Segoe UI', system-ui, sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: Consolas, 'Cascadia Mono', monospace;
    --vscode-editor-font-size: 13px;
    --vscode-editor-line-height: 20px;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-disabledForeground: #777777;
    --vscode-focusBorder: #0078d4;
    --vscode-contrastActiveBorder: #0078d4;
    --vscode-sideBar-background: #1e1e1e;
    --vscode-sideBar-foreground: #cccccc;
    --vscode-editor-background: #1e1e1e;
    --vscode-editor-foreground: #d4d4d4;
    --vscode-editor-border: #3c3c3c;
    --vscode-editorGroup-border: #2d2d30;
    --vscode-editorWidget-border: #454545;
    --vscode-panel-border: #2d2d30;
    --vscode-input-background: #252526;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-input-placeholderForeground: #8c8c8c;
    --vscode-button-background: #0e639c;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-foreground: #ffffff;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryHoverBackground: #45494e;
    --vscode-button-secondaryForeground: #ffffff;
    --vscode-toolbar-background: #252526;
    --vscode-toolbar-hoverBackground: #2a2d2e;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #04395e;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-list-inactiveSelectionBackground: #37373d;
    --vscode-editor-inactiveSelectionBackground: #3a3d41;
    --vscode-dropdown-background: #252526;
    --vscode-dropdown-foreground: #cccccc;
    --vscode-dropdown-border: #3c3c3c;
    --vscode-menu-background: #252526;
    --vscode-menu-foreground: #cccccc;
    --vscode-menu-border: #454545;
    --vscode-menu-shadow: rgba(0, 0, 0, 0.36);
    --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
    --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
    --vscode-scrollbarSlider-activeBackground: rgba(191, 191, 191, 0.4);
    --vscode-badge-background: #4d4d4d;
    --vscode-badge-foreground: #ffffff;
    --vscode-textLink-foreground: #3794ff;
    --vscode-textLink-activeForeground: #4daafc;
    --vscode-textCodeBlock-background: #1b1b1b;
    --vscode-textBlockQuote-background: #252526;
    --vscode-textBlockQuote-foreground: #cccccc;
    --vscode-textPreformat-foreground: #d7ba7d;
    --vscode-textSeparator-foreground: #424242;
    --vscode-icon-foreground: #c5c5c5;
    --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
    --vscode-errorForeground: #f48771;
    --vscode-problemsErrorIcon-foreground: #f48771;
    --vscode-testing-iconFailed: #f48771;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-charts-green: #89d185;
    --vscode-charts-yellow: #dcdcaa;
    --vscode-progressBar-background: #0e70c0;
    --vscode-banner-background: #252526;
    --vscode-banner-foreground: #cccccc;
    --vscode-banner-iconForeground: #3794ff;
    --vscode-editor-findMatchHighlightBackground: #515c6a;
    --vscode-debugTokenExpression-string: #ce9178;
    --vscode-debugTokenExpression-number: #b5cea8;
    --vscode-debugTokenExpression-name: #9cdcfe;
    --vscode-debugTokenExpression-type: #4ec9b0;
    --vscode-diffEditor-insertedTextBackground: rgba(46, 160, 67, 0.25);
    --vscode-diffEditor-removedTextBackground: rgba(248, 81, 73, 0.25);
    --vscode-diffEditor-insertedLineBackground: rgba(46, 160, 67, 0.25);
    --vscode-diffEditor-removedLineBackground: rgba(248, 81, 73, 0.25);
}
:root[data-vscline-theme='light'] {
    color-scheme: light;
    --vscode-foreground: #111827;
    --vscode-descriptionForeground: #374151;
    --vscode-disabledForeground: #6b7280;
    --vscode-focusBorder: #0969da;
    --vscode-contrastActiveBorder: #0969da;
    --vscode-sideBar-background: #f3f6fb;
    --vscode-sideBar-foreground: #111827;
    --vscode-editor-background: #ffffff;
    --vscode-editor-foreground: #111827;
    --vscode-editor-border: #cbd5e1;
    --vscode-editorGroup-border: #cbd5e1;
    --vscode-editorWidget-background: #ffffff;
    --vscode-editorWidget-border: #cbd5e1;
    --vscode-panel-border: #cbd5e1;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #111827;
    --vscode-input-border: #64748b;
    --vscode-input-placeholderForeground: #4b5563;
    --vscode-button-background: #0969da;
    --vscode-button-hoverBackground: #0757b8;
    --vscode-button-foreground: #ffffff;
    --vscode-button-secondaryBackground: #e2e8f0;
    --vscode-button-secondaryHoverBackground: #cbd5e1;
    --vscode-button-secondaryForeground: #111827;
    --vscode-toolbar-background: #f3f6fb;
    --vscode-toolbar-hoverBackground: #e2e8f0;
    --vscode-list-hoverBackground: #e2e8f0;
    --vscode-list-activeSelectionBackground: #0969da;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-list-inactiveSelectionBackground: #dbeafe;
    --vscode-editor-inactiveSelectionBackground: #dbeafe;
    --vscode-dropdown-background: #ffffff;
    --vscode-dropdown-foreground: #111827;
    --vscode-dropdown-border: #64748b;
    --vscode-menu-background: #ffffff;
    --vscode-menu-foreground: #111827;
    --vscode-menu-border: #cbd5e1;
    --vscode-menu-shadow: rgba(31, 35, 40, 0.16);
    --vscode-scrollbarSlider-background: rgba(31, 35, 40, 0.22);
    --vscode-scrollbarSlider-hoverBackground: rgba(31, 35, 40, 0.34);
    --vscode-scrollbarSlider-activeBackground: rgba(31, 35, 40, 0.48);
    --vscode-badge-background: #0969da;
    --vscode-badge-foreground: #ffffff;
    --vscode-textLink-foreground: #0969da;
    --vscode-textLink-activeForeground: #0550ae;
    --vscode-textCodeBlock-background: #f6f8fa;
    --vscode-textBlockQuote-background: #f6f8fa;
    --vscode-textBlockQuote-foreground: #57606a;
    --vscode-textPreformat-foreground: #8250df;
    --vscode-textSeparator-foreground: #d0d7de;
    --vscode-icon-foreground: #57606a;
    --vscode-widget-shadow: rgba(31, 35, 40, 0.16);
    --vscode-errorForeground: #cf222e;
    --vscode-problemsErrorIcon-foreground: #cf222e;
    --vscode-testing-iconFailed: #cf222e;
    --vscode-editorWarning-foreground: #9a6700;
    --vscode-charts-green: #1a7f37;
    --vscode-charts-yellow: #bf8700;
    --vscode-progressBar-background: #0969da;
    --vscode-banner-background: #e2e8f0;
    --vscode-banner-foreground: #111827;
    --vscode-banner-iconForeground: #0969da;
    --vscode-editor-findMatchHighlightBackground: #fff8c5;
    --vscode-debugTokenExpression-string: #953800;
    --vscode-debugTokenExpression-number: #116329;
    --vscode-debugTokenExpression-name: #0550ae;
    --vscode-debugTokenExpression-type: #8250df;
    --vscode-diffEditor-insertedTextBackground: rgba(26, 127, 55, 0.18);
    --vscode-diffEditor-removedTextBackground: rgba(207, 34, 46, 0.16);
    --vscode-diffEditor-insertedLineBackground: rgba(26, 127, 55, 0.14);
    --vscode-diffEditor-removedLineBackground: rgba(207, 34, 46, 0.12);
}
html, body, #root {
    background: var(--vscode-sideBar-background) !important;
    color: var(--vscode-foreground) !important;
    font-family: var(--vscode-font-family) !important;
    font-size: var(--vscode-font-size) !important;
    scrollbar-gutter: stable !important;
    scrollbar-width: auto !important;
    scrollbar-color: var(--vscode-scrollbarSlider-background) transparent !important;
}
*::-webkit-scrollbar {
    width: 12px !important;
    height: 12px !important;
}
*::-webkit-scrollbar-track {
    background: transparent !important;
}
*::-webkit-scrollbar-thumb {
    background-color: var(--vscode-scrollbarSlider-background) !important;
    border: 3px solid transparent !important;
    border-radius: 8px !important;
    background-clip: content-box !important;
}
*::-webkit-scrollbar-thumb:hover {
    background-color: var(--vscode-scrollbarSlider-hoverBackground) !important;
}
*::-webkit-scrollbar-thumb:active {
    background-color: var(--vscode-scrollbarSlider-activeBackground) !important;
}
`;
            (document.head || document.documentElement).appendChild(themeStyle);
            window.addEventListener('storage', function (event) {
                if (event.key === 'ligVsTheme') {
                    applyThemeMode(event.newValue);
                }
            });
            window.addEventListener('ligvs-theme-change', function (event) {
                applyThemeMode(event.detail);
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    let vscodeState = {};
    const diagnostics = window.__vsClineDiagnostics = {
        outgoingMessages: 0,
        incomingMessages: 0,
        lastOutgoingType: '',
        lastIncomingType: '',
        lastOutgoingMessages: [],
        lastIncomingMessages: [],
        console: [],
        errors: []
    };
    const api = {
        postMessage: function (message) {
            diagnostics.outgoingMessages++;
            diagnostics.lastOutgoingType = message && message.type ? String(message.type) : '';
            diagnostics.lastOutgoingMessages.push({
                at: new Date().toISOString(),
                message: message
            });
            if (diagnostics.lastOutgoingMessages.length > 30) {
                diagnostics.lastOutgoingMessages.shift();
            }
            window.chrome.webview.postMessage(message);
        },
        setState: function (state) { vscodeState = state || {}; return vscodeState; },
        getState: function () { return vscodeState; }
    };

    window.__vsClineAcquireVsCodeApi = api;
    window.acquireVsCodeApi = function () { return api; };

    if (!installThemeShim()) {
        document.addEventListener('DOMContentLoaded', installThemeShim, { once: true });
    }

    window.chrome.webview.addEventListener('message', function (event) {
        diagnostics.incomingMessages++;
        diagnostics.lastIncomingType = event.data && event.data.type ? String(event.data.type) : '';
        diagnostics.lastIncomingMessages.push({
            at: new Date().toISOString(),
            message: event.data
        });
        if (diagnostics.lastIncomingMessages.length > 30) {
            diagnostics.lastIncomingMessages.shift();
        }
        window.dispatchEvent(new MessageEvent('message', { data: event.data }));
    });

    function report(kind, value) {
        const item = {
            kind: kind,
            message: String(value && (value.message || value.reason || value.error || value) || ''),
            stack: String(value && (value.stack || (value.error && value.error.stack) || '') || '')
        };
        diagnostics.errors.push(item);
        try {
            window.chrome.webview.postMessage({
                type: 'vscline.diagnostic',
                kind: kind,
                message: item.message,
                stack: item.stack
            });
        } catch (_) {}
    }

            ['error', 'warn', 'log'].forEach(function (level) {
        const original = console[level] && console[level].bind(console);
        console[level] = function () {
            diagnostics.console.push({
                level: level,
                message: Array.prototype.map.call(arguments, function (arg) {
                    try {
                        if (typeof arg === 'string') return arg;
                        if (arg && typeof arg === 'object' && ('message' in arg || 'stack' in arg)) {
                            return String(arg.message || arg.stack || arg);
                        }
                        return JSON.stringify(arg);
                    }
                    catch (_) { return String(arg); }
                }).join(' ')
            });
            if (original) original.apply(console, arguments);
        };
    });

    window.addEventListener('error', function (event) {
        if (event.target && event.target !== window) {
            report('resource', event.target.src || event.target.href || event.target.tagName);
            return;
        }
        report('error', event.error || event.message);
    }, true);
    window.addEventListener('unhandledrejection', function (event) {
        report('unhandledrejection', event.reason);
    });
})();");

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
                ShowError(BuildWebView2InitializationError(
                    ex,
                    assemblyDirectory,
                    runtimeLabel,
                    browserExecutableFolder,
                    initializationFailures));
            }
        }

        private static string BuildWebView2InitializationError(
            Exception ex,
            string assemblyDirectory,
            string? runtimeLabel,
            string? browserExecutableFolder,
            IReadOnlyCollection<string> initializationFailures)
        {
            var bundledRuntimeRoot = Path.Combine(assemblyDirectory, "WebView2Runtime");
            var localRuntimeRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime");

            var detail = string.IsNullOrEmpty(browserExecutableFolder)
                ? "No bundled WebView2 Fixed Version Runtime was detected."
                : $"{runtimeLabel ?? "WebView2"} runtime was detected at:\n{browserExecutableFolder}";
            var failures = initializationFailures.Count == 0
                ? string.Empty
                : "\n\nAttempts:\n" + string.Join("\n", initializationFailures);
            var assembly = Assembly.GetExecutingAssembly();
            var assemblyVersion = GetDisplayAssemblyVersion(assembly);
            var assemblyLocation = assembly.Location;
            var localRuntime = FindRuntimeFolder(localRuntimeRoot) ?? "(none)";
            var packagedRuntime = FindRuntimeFolder(bundledRuntimeRoot) ?? "(none)";

            return
                $"WebView2 init failed:\n{ex.Message}\nHRESULT: 0x{ex.HResult:X8}\n" +
                $"VsClineAgent assembly: {assemblyVersion}\n{assemblyLocation}\n\n" +
                $"{detail}\n\nDetected runtime folders:\n" +
                $"Packaged: {packagedRuntime}\n" +
                $"Local: {localRuntime}{failures}\n\n" +
                "For air-gapped use, bundle or extract a WebView2 Fixed Version Runtime so msedgewebview2.exe exists under one of these locations:\n" +
                $"{bundledRuntimeRoot}\\Microsoft.WebView2.FixedVersionRuntime.<version>.x64\\msedgewebview2.exe\n" +
                $"{localRuntimeRoot}\\Microsoft.WebView2.FixedVersionRuntime.<version>.x64\\msedgewebview2.exe";
        }

        private static IReadOnlyList<WebView2RuntimeCandidate> GetWebView2RuntimeCandidates(string assemblyDirectory)
        {
            var candidates = new List<WebView2RuntimeCandidate>();
            if (IsWebView2RuntimeAvailable(null))
                candidates.Add(new WebView2RuntimeCandidate("System Evergreen", null));

            var packagedRuntime = FindRuntimeFolder(Path.Combine(assemblyDirectory, "WebView2Runtime"));
            if (!string.IsNullOrEmpty(packagedRuntime))
            {
                var localRuntime = CopyWebView2RuntimeToLocalCache(packagedRuntime!);
                if (!string.IsNullOrEmpty(localRuntime))
                    candidates.Add(new WebView2RuntimeCandidate("Bundled Fixed", localRuntime));
            }

            var existingBundledRuntime = FindBundledWebView2Runtime(assemblyDirectory);
            if (!string.IsNullOrEmpty(existingBundledRuntime) &&
                !candidates.Any(candidate => string.Equals(candidate.BrowserExecutableFolder, existingBundledRuntime, StringComparison.OrdinalIgnoreCase)))
            {
                candidates.Add(new WebView2RuntimeCandidate("Bundled Fixed", existingBundledRuntime));
            }

            if (candidates.Count == 0)
                candidates.Add(new WebView2RuntimeCandidate("System Evergreen", null));

            return candidates;
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

            if (IsOfficialFixedRuntimeFolder(candidateRoot) &&
                File.Exists(Path.Combine(candidateRoot, "msedgewebview2.exe")))
            {
                return candidateRoot;
            }

            foreach (var subDirectory in Directory.EnumerateDirectories(candidateRoot))
            {
                if (IsOfficialFixedRuntimeFolder(subDirectory) &&
                    File.Exists(Path.Combine(subDirectory, "msedgewebview2.exe")))
                {
                    return subDirectory;
                }
            }

            return null;
        }

        private static bool IsOfficialFixedRuntimeFolder(string runtimeFolder)
        {
            var name = Path.GetFileName(runtimeFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            return name.StartsWith("Microsoft.WebView2.FixedVersionRuntime.", StringComparison.OrdinalIgnoreCase) &&
                name.EndsWith(".x64", StringComparison.OrdinalIgnoreCase);
        }

        private static string GetWebView2UserDataFolder(string runtimeLabel, string? browserExecutableFolder)
        {
            var runtimeId = string.IsNullOrWhiteSpace(browserExecutableFolder)
                ? SanitizePathSegment(runtimeLabel)
                : Path.GetFileName(browserExecutableFolder!.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) ?? "Bundled";

            runtimeId = SanitizePathSegment(runtimeId);
            var profileVersion = GetWebView2ProfileVersion();
            var profileRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Data",
                profileVersion);
            CleanupVersionedCacheDirectory(Path.GetDirectoryName(profileRoot), profileVersion, 2);
            return Path.Combine(
                profileRoot,
                runtimeId);
        }

        private static string GetWebView2ProfileVersion()
        {
            var assemblyName = Assembly.GetExecutingAssembly().GetName();
            var name = string.IsNullOrWhiteSpace(assemblyName.Name) ? "VsClineAgent" : assemblyName.Name!;
            var version = assemblyName.Version?.ToString() ?? "unknown";
            return SanitizePathSegment(name + "-" + version);
        }

        private static string SanitizePathSegment(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return "Default";

            foreach (var invalidChar in Path.GetInvalidFileNameChars())
                value = value.Replace(invalidChar, '_');

            return value.Replace(' ', '_');
        }

        private static string? CopyWebView2RuntimeToLocalCache(string sourceRuntimeFolder)
        {
            var version = Path.GetFileName(sourceRuntimeFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            if (string.IsNullOrWhiteSpace(version))
                return null;

            var targetRuntimeFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime",
                version);
            var stampPath = Path.Combine(targetRuntimeFolder, ".runtime.stamp");
            var expectedStamp = GetRuntimeStamp(sourceRuntimeFolder);

            if (File.Exists(Path.Combine(targetRuntimeFolder, "msedgewebview2.exe")) &&
                File.Exists(stampPath) &&
                string.Equals(File.ReadAllText(stampPath), expectedStamp, StringComparison.Ordinal))
            {
                return targetRuntimeFolder;
            }

            if (Directory.Exists(targetRuntimeFolder))
                Directory.Delete(targetRuntimeFolder, true);

            CopyDirectory(sourceRuntimeFolder, targetRuntimeFolder);
            File.WriteAllText(stampPath, expectedStamp);
            CleanupVersionedCacheDirectory(Path.GetDirectoryName(targetRuntimeFolder), version, 1);
            return targetRuntimeFolder;
        }

        private static void CleanupVersionedCacheDirectory(string? cacheRoot, string currentVersion, int keepRecentCount)
        {
            if (string.IsNullOrWhiteSpace(cacheRoot) || !Directory.Exists(cacheRoot))
                return;

            var root = Path.GetFullPath(cacheRoot);
            var candidates = Directory.EnumerateDirectories(root)
                .Select(path => new DirectoryInfo(path))
                .Where(info => !string.Equals(info.Name, currentVersion, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(info => info.LastWriteTimeUtc)
                .Skip(Math.Max(0, keepRecentCount))
                .ToList();

            foreach (var candidate in candidates)
                TryDeleteDirectoryUnderRoot(candidate.FullName, root);
        }

        private static void TryDeleteDirectoryUnderRoot(string path, string root)
        {
            try
            {
                var resolved = Path.GetFullPath(path);
                var resolvedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;
                if (!resolved.StartsWith(resolvedRoot, StringComparison.OrdinalIgnoreCase))
                    return;

                Directory.Delete(resolved, true);
            }
            catch
            {
            }
        }

        private static void CopyDirectory(string sourceDirectory, string targetDirectory)
        {
            Directory.CreateDirectory(targetDirectory);

            foreach (var directory in Directory.EnumerateDirectories(sourceDirectory, "*", SearchOption.AllDirectories))
            {
                var relativeDirectory = directory.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                Directory.CreateDirectory(Path.Combine(targetDirectory, relativeDirectory));
            }

            foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories))
            {
                var relativeFile = file.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var targetFile = Path.Combine(targetDirectory, relativeFile);
                var targetParent = Path.GetDirectoryName(targetFile);
                if (!string.IsNullOrWhiteSpace(targetParent))
                    Directory.CreateDirectory(targetParent);

                File.Copy(file, targetFile, true);
            }
        }

        private static string GetRuntimeStamp(string runtimeFolder)
        {
            var exePath = Path.Combine(runtimeFolder, "msedgewebview2.exe");
            var info = new FileInfo(exePath);
            if (!info.Exists)
                return "missing";

            var fileCount = 0;
            long totalBytes = 0;
            foreach (var file in Directory.EnumerateFiles(runtimeFolder, "*", SearchOption.AllDirectories))
            {
                var fileInfo = new FileInfo(file);
                fileCount++;
                totalBytes += fileInfo.Length;
            }

            return info.Length + ":" + info.LastWriteTimeUtc.Ticks + ":" + fileCount + ":" + totalBytes;
        }

        private static void EnsureWebView2RuntimeAvailable(string? browserExecutableFolder)
        {
            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString(browserExecutableFolder);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                throw;
            }
        }

        private static bool IsWebView2RuntimeAvailable(string? browserExecutableFolder)
        {
            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString(browserExecutableFolder);
                return true;
            }
            catch (WebView2RuntimeNotFoundException)
            {
                return false;
            }
        }

        private sealed class WebView2RuntimeCandidate
        {
            public WebView2RuntimeCandidate(string label, string? browserExecutableFolder)
            {
                Label = label;
                BrowserExecutableFolder = browserExecutableFolder;
            }

            public string Label { get; }

            public string? BrowserExecutableFolder { get; }
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (ShouldOpenOutsideWebView(e.Uri))
            {
                e.Cancel = true;
                OpenExternalBrowser(e.Uri);
                return;
            }

            _webViewReady = false;
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

                _webViewReady = true;
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
                ScheduleWebViewMessageFlush();

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
                    TryHandlePassiveStreamingSubscription(webMessageAsJson))
                    return;

                if (_sidecarProcess == null || !_sidecarProcess.IsRunning)
                {
                    var restarted = await TryEnsureSidecarRunningAsync();
                    if (!restarted)
                    {
                        await SendGrpcErrorIfPossibleAsync(webMessageAsJson, GetSidecarNotRunningMessage());
                        return;
                    }
                }

                var sidecarProcess = _sidecarProcess;
                if (sidecarProcess == null || !sidecarProcess.IsRunning)
                {
                    await SendGrpcErrorIfPossibleAsync(webMessageAsJson, GetSidecarNotRunningMessage());
                    return;
                }

                var handledBySidecar = await sidecarProcess.TryHandleWebviewMessageAsync(
                    webMessageAsJson,
                    SendToWebViewAsync,
                    CancellationToken.None);

                if (!handledBySidecar)
                    await SendGrpcErrorIfPossibleAsync(webMessageAsJson, "Unhandled WebView RPC. The VSIX wrapper only routes through the LIG VS SDK sidecar.");
            }
            catch (Exception ex)
            {
                _lastSidecarError = ex.ToString();
                if (TryHandlePassiveStreamingSubscription(webMessageAsJson))
                    return;

                await SendGrpcErrorIfPossibleAsync(webMessageAsJson, ex.Message);
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
            ClearPendingWebViewMessages();

            DisposeSidecarProcessQuietly();

            try
            {
                _commandExecutionService.Dispose();
            }
            catch
            {
            }
        }

        private void ClearPendingWebViewMessages()
        {
            lock (_webViewPostLock)
            {
                _webViewPostFlushScheduled = false;
                _pendingWebViewMessages.Clear();
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
                            ScheduleWebViewMessageFlush();
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

        private static bool TryHandlePassiveStreamingSubscription(string rawJson)
        {
            try
            {
                var envelope = JObject.Parse(rawJson);
                if (!string.Equals(envelope.Value<string>("type"), "grpc_request", StringComparison.Ordinal))
                    return false;

                var request = envelope["grpc_request"] as JObject;
                if (request == null)
                    return false;

                var isStreaming = request.Value<bool?>("is_streaming") == true ||
                                  request.Value<bool?>("isStreaming") == true;
                if (!isStreaming)
                    return false;

                var key = (request.Value<string>("service") ?? "") + "." + (request.Value<string>("method") ?? "");
                switch (key)
                {
                    case "UiService.subscribeToMcpButtonClicked":
                    case "UiService.subscribeToHistoryButtonClicked":
                    case "UiService.subscribeToChatButtonClicked":
                    case "UiService.subscribeToSettingsButtonClicked":
                    case "UiService.subscribeToWorktreesButtonClicked":
                    case "UiService.subscribeToAccountButtonClicked":
                    case "UiService.subscribeToRelinquishControl":
                    case "UiService.subscribeToShowWebview":
                    case "UiService.subscribeToAddToInput":
                    case "UiService.subscribeToPartialMessage":
                    case "McpService.subscribeToMcpMarketplaceCatalog":
                    case "McpService.subscribeToMcpServers":
                    case "ModelsService.subscribeToOpenRouterModels":
                    case "ModelsService.subscribeToLiteLlmModels":
                        return true;
                    default:
                        return false;
                }
            }
            catch
            {
                return false;
            }
        }

        private async Task SendGrpcErrorIfPossibleAsync(string rawJson, string message)
        {
            try
            {
                var envelope = JObject.Parse(rawJson);
                if (!string.Equals(envelope.Value<string>("type"), "grpc_request", StringComparison.Ordinal))
                {
                    await SendToWebViewAsync(new { type = "error", message });
                    return;
                }

                var request = envelope["grpc_request"] as JObject;
                if (request == null)
                {
                    await SendToWebViewAsync(new { type = "error", message });
                    return;
                }

                var requestId = request.Value<string>("request_id") ?? request.Value<string>("requestId");
                if (string.IsNullOrWhiteSpace(requestId))
                {
                    await SendToWebViewAsync(new { type = "error", message });
                    return;
                }

                await SendToWebViewAsync(new
                {
                    type = "grpc_response",
                    grpc_response = new
                    {
                        request_id = requestId,
                        error = message,
                        is_streaming = request.Value<bool?>("is_streaming") == true ||
                                       request.Value<bool?>("isStreaming") == true
                    }
                });
            }
            catch
            {
                await SendToWebViewAsync(new { type = "error", message });
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
                EnqueueWebViewMessage(json);
            }
            catch { }

            return Task.CompletedTask;
        }

        private void EnqueueWebViewMessage(string json)
        {
            lock (_webViewPostLock)
            {
                if (_disposed)
                    return;

                _pendingWebViewMessages.Enqueue(json);
                TrimPendingWebViewMessages();
                if (_webViewPostFlushScheduled)
                    return;

                _webViewPostFlushScheduled = true;
            }

            ScheduleWebViewMessageFlush();
        }

        private void TrimPendingWebViewMessages()
        {
            if (_pendingWebViewMessages.Count <= MaxPendingWebViewMessages)
                return;

            CoalescePendingStateMessages();
            while (_pendingWebViewMessages.Count > MaxPendingWebViewMessages)
                _pendingWebViewMessages.Dequeue();
        }

        private void CoalescePendingStateMessages()
        {
            var latestStateByRequest = new Dictionary<string, string>(StringComparer.Ordinal);
            var ordered = _pendingWebViewMessages.ToList();
            foreach (var message in ordered)
            {
                var requestId = TryGetStateResponseRequestId(message);
                if (!string.IsNullOrWhiteSpace(requestId))
                    latestStateByRequest[requestId!] = message;
            }

            if (latestStateByRequest.Count == 0)
                return;

            _pendingWebViewMessages.Clear();
            var emittedLatestState = new HashSet<string>(StringComparer.Ordinal);
            foreach (var message in ordered)
            {
                var requestId = TryGetStateResponseRequestId(message);
                if (string.IsNullOrWhiteSpace(requestId))
                {
                    _pendingWebViewMessages.Enqueue(message);
                    continue;
                }

                if (emittedLatestState.Contains(requestId!))
                    continue;

                var latest = latestStateByRequest[requestId!];
                if (ReferenceEquals(message, latest) || string.Equals(message, latest, StringComparison.Ordinal))
                {
                    _pendingWebViewMessages.Enqueue(latest);
                    emittedLatestState.Add(requestId!);
                }
            }
        }

        private static string? TryGetStateResponseRequestId(string json)
        {
            try
            {
                var envelope = JObject.Parse(json);
                if (!string.Equals(envelope.Value<string>("type"), "grpc_response", StringComparison.Ordinal))
                    return null;

                var response = envelope["grpc_response"] as JObject;
                var message = response?["message"] as JObject;
                if (message?["stateJson"] == null)
                    return null;

                return response?.Value<string>("request_id");
            }
            catch
            {
                return null;
            }
        }

        private void ScheduleWebViewMessageFlush()
        {
            try
            {
                Dispatcher.BeginInvoke(
                    new Action(FlushPendingWebViewMessages),
                    System.Windows.Threading.DispatcherPriority.Background);
            }
            catch
            {
                lock (_webViewPostLock)
                {
                    _webViewPostFlushScheduled = false;
                }
            }
        }

        private void FlushPendingWebViewMessages()
        {
            string[] messages;
            lock (_webViewPostLock)
            {
                _webViewPostFlushScheduled = false;
                if (_disposed || _pendingWebViewMessages.Count == 0)
                {
                    _pendingWebViewMessages.Clear();
                    return;
                }

                if (!_webViewReady || webView.CoreWebView2 == null)
                    return;

                messages = _pendingWebViewMessages.ToArray();
                _pendingWebViewMessages.Clear();
            }

            foreach (var json in messages)
            {
                try
                {
                    if (webView.CoreWebView2 != null)
                        webView.CoreWebView2.PostWebMessageAsJson(json);
                }
                catch
                {
                }
            }
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
            builder.AppendLine("WebView ready: " + _webViewReady);
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
