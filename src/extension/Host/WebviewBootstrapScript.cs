namespace VsClineAgent.Host
{
    internal static class WebviewBootstrapScript
    {
        public const string Source = @"
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
                        protocolVersion: 1,
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
    --vscode-font-family: 'Noto Sans KR', 'Segoe UI', system-ui, sans-serif;
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
})();";
    }
}
