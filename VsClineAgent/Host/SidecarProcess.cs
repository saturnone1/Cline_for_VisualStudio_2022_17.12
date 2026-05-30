using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Services;

namespace VsClineAgent.Host
{
    internal sealed class SidecarProcess : IDisposable
    {
        private readonly string _assemblyDirectory;
        private readonly VsEditorService _editorService;
        private readonly VsCommandExecutionService _commandExecutionService;
        private Process? _process;
        private NamedPipeJsonRpcClient? _client;
        private Func<object, Task>? _postToWebviewAsync;
        private readonly object _recentOutputLock = new object();
        private readonly Queue<string> _recentOutput = new Queue<string>();
        private string? _logFilePath;

        public SidecarProcess(
            string assemblyDirectory,
            VsEditorService editorService,
            VsCommandExecutionService commandExecutionService)
        {
            _assemblyDirectory = assemblyDirectory;
            _editorService = editorService;
            _commandExecutionService = commandExecutionService;
        }

        public bool IsRunning => _process != null && !_process.HasExited && _client != null && _client.IsConnected;

        public async Task<bool> TryHandleWebviewMessageAsync(
            string rawJson,
            Func<object, Task> postToWebviewAsync,
            CancellationToken cancellationToken)
        {
            if (!IsRunning || _client == null)
                return false;

            _postToWebviewAsync = postToWebviewAsync;
            InteractionLog.Write("host->sidecar", "webview.message", rawJson);

            var result = await _client.SendRequestAsync(
                "webview.message",
                new { rawJson },
                cancellationToken).ConfigureAwait(false) as JObject;
            InteractionLog.Write("sidecar->host", "webview.message.result", result);

            if (result == null)
                return false;

            var webviewMessages = result["webviewMessages"] as JArray;
            if (webviewMessages != null)
            {
                foreach (var message in webviewMessages)
                {
                    InteractionLog.Write("host->webview", "webview.message.batchItem", message);
                    await postToWebviewAsync(message).ConfigureAwait(false);
                }
            }

            return result.Value<bool?>("handled") == true;
        }

        public async Task<string> EnsureStartedAsync(CancellationToken cancellationToken)
        {
            if (IsRunning)
                return "already-running";

            var pipeName = @"\\.\pipe\VsClineAgent-" + Guid.NewGuid().ToString("N");
            var sidecarDirectory = Path.Combine(_assemblyDirectory, "Sidecar");
            var runtimeDirectory = PrepareSidecarRuntime(sidecarDirectory);
            var scriptPath = Path.Combine(runtimeDirectory, "cline-sidecar.js");
            var bundledNodePath = Path.Combine(sidecarDirectory, "node.exe");
            var nodePath = File.Exists(bundledNodePath) ? bundledNodePath : "node";
            _logFilePath = GetSidecarLogPath();

            if (!File.Exists(scriptPath))
                throw new FileNotFoundException("Cline sidecar entrypoint was not found.", scriptPath);

            CaptureSidecarLine("sidecar:start", "node=" + nodePath);
            CaptureSidecarLine("sidecar:start", "script=" + scriptPath);
            CaptureSidecarLine("sidecar:start", "runtime=" + runtimeDirectory);
            CaptureSidecarLine("sidecar:start", "pipe=" + pipeName);

            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = Quote(scriptPath) + " --pipe " + Quote(pipeName),
                WorkingDirectory = runtimeDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            try
            {
                _process = Process.Start(startInfo)
                    ?? throw new InvalidOperationException("Failed to start the Cline sidecar process.");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(BuildStartupDiagnostic("Failed to launch node.", ex), ex);
            }

            _process.EnableRaisingEvents = true;
            _process.Exited += (_, __) =>
                CaptureSidecarLine("sidecar:exit", "exitCode=" + SafeExitCode(_process));
            _process.OutputDataReceived += (_, e) => CaptureSidecarLine("sidecar", e.Data);
            _process.ErrorDataReceived += (_, e) => CaptureSidecarLine("sidecar:error", e.Data);
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            _client = new NamedPipeJsonRpcClient(pipeName);
            _client.RequestReceived += HandleSidecarRequestAsync;
            JToken? result;
            try
            {
                await ConnectWithRetryAsync(_client, _process, cancellationToken).ConfigureAwait(false);

                result = await _client.SendRequestAsync(
                    "health.ping",
                    new { client = "VsClineAgent", protocol = 1 },
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Dispose();
                throw new InvalidOperationException(BuildStartupDiagnostic("Cline sidecar did not become ready.", ex), ex);
            }

            return ((JObject?)result)?["status"]?.ToString() ?? "unknown";
        }

        private async Task<JToken?> HandleSidecarRequestAsync(string method, JToken? parameters)
        {
            InteractionLog.Write("sidecar->host", method, parameters);
            switch (method)
            {
                case "host.health":
                    return new JObject
                    {
                        ["status"] = "ok",
                        ["host"] = "visualstudio-vsix",
                        ["received"] = parameters == null ? null : parameters.DeepClone()
                    };
                case "host.workspace.getRoots":
                case "workspace.getRoots":
                    return await GetWorkspaceRootsAsync().ConfigureAwait(false);
                case "host.editor.getOpenDocuments":
                case "workspace.getOpenDocuments":
                    return new JArray(await _editorService.GetOpenDocumentsAsync().ConfigureAwait(false));
                case "workspace.getWorkspacePaths":
                    return await GetWorkspacePathsAsync().ConfigureAwait(false);
                case "workspace.getDiagnostics":
                    return await GetDiagnosticsAsync().ConfigureAwait(false);
                case "host.editor.getActiveFile":
                case "window.getActiveFile":
                    return new JObject
                    {
                        ["path"] = await _editorService.GetActiveFilePathAsync().ConfigureAwait(false)
                    };
                case "host.fs.fileExists":
                case "workspace.fileExists":
                    return new JObject
                    {
                        ["exists"] = File.Exists(GetStringParameter(parameters, "path"))
                    };
                case "host.fs.readTextFile":
                case "workspace.readTextFile":
                    return ReadTextFile(parameters);
                case "workspace.writeTextFile":
                    return WriteTextFile(parameters);
                case "workspace.createDirectory":
                    return CreateDirectory(parameters);
                case "workspace.listFiles":
                    return ListFiles(parameters);
                case "workspace.searchFiles":
                    return SearchFiles(parameters);
                case "window.showMessage":
                    await _editorService.SetStatusBarAsync(GetStringParameter(parameters, "message")).ConfigureAwait(false);
                    return new JObject { ["shown"] = true };
                case "window.openFile":
                    await _editorService.OpenFileAsync(
                        GetStringParameter(parameters, "filePath"),
                        GetIntParameter(parameters, "line")).ConfigureAwait(false);
                    return new JObject();
                case "env.getPlatform":
                case "env.getHostVersion":
                    return new JObject
                    {
                        ["platform"] = "win32",
                        ["appName"] = "Visual Studio",
                        ["host"] = "vs2022",
                        ["version"] = "17.12"
                    };
                case "env.clipboardReadText":
                    return new JObject { ["value"] = InvokeOnUiThread(() => Clipboard.GetText()) };
                case "env.clipboardWriteText":
                    InvokeOnUiThread(() => Clipboard.SetText(GetStringParameter(parameters, "value")));
                    return new JObject();
                case "env.openExternal":
                    OpenExternal(GetStringParameter(parameters, "value"));
                    return new JObject();
                case "env.debugLog":
                    CaptureSidecarLine("sidecar:debug", GetStringParameter(parameters, "message"));
                    return new JObject();
                case "webview.postMessage":
                    if (_postToWebviewAsync != null && parameters is JObject postMessage)
                    {
                        var message = postMessage["message"];
                        if (message != null)
                        {
                            InteractionLog.Write("host->webview", "webview.postMessage", message);
                            await _postToWebviewAsync(message).ConfigureAwait(false);
                        }
                    }
                    return new JObject { ["posted"] = true };
                case "workspace.executeCommandInTerminal":
                    return await ExecuteCommandInTerminalAsync(parameters).ConfigureAwait(false);
                case "workspace.cancelCommands":
                    return await CancelCommandsAsync().ConfigureAwait(false);
                case "workspace.saveOpenDocumentIfDirty":
                    return new JObject
                    {
                        ["saved"] = await _editorService.SaveDocumentIfDirtyAsync(
                            GetStringParameter(parameters, "filePath")).ConfigureAwait(false)
                    };
                case "workspace.openProblemsPanel":
                    await _editorService.ExecuteCommandAsync("View.ErrorList").ConfigureAwait(false);
                    return new JObject { ["success"] = true };
                case "workspace.openTerminalPanel":
                    await _editorService.ExecuteCommandAsync("View.Terminal").ConfigureAwait(false);
                    return new JObject { ["success"] = true };
                case "diff.openDiff":
                    return await OpenDiffAsync(parameters).ConfigureAwait(false);
                case "diff.closeAllDiffs":
                    return new JObject { ["success"] = true };
                default:
                    throw new InvalidOperationException("Unsupported host method: " + method);
            }
        }

        private async Task<JArray> GetWorkspaceRootsAsync()
        {
            var root = await _editorService.GetSolutionRootAsync().ConfigureAwait(false);
            var roots = new JArray();

            if (!string.IsNullOrWhiteSpace(root))
            {
                roots.Add(new JObject
                {
                    ["path"] = root,
                    ["name"] = Path.GetFileName(root)
                });
            }

            return roots;
        }

        private async Task<JArray> GetWorkspacePathsAsync()
        {
            var root = await _editorService.GetSolutionRootAsync().ConfigureAwait(false);
            return string.IsNullOrWhiteSpace(root)
                ? new JArray()
                : new JArray(root!);
        }

        private async Task<JObject> GetDiagnosticsAsync()
        {
            var diagnostics = await _editorService.GetDiagnosticsAsync().ConfigureAwait(false);
            var fileDiagnostics = new JArray();

            foreach (var group in diagnostics.GroupBy(item => item.File ?? ""))
            {
                var entries = new JArray();
                foreach (var diagnostic in group)
                {
                    entries.Add(new JObject
                    {
                        ["message"] = diagnostic.Message,
                        ["line"] = diagnostic.Line,
                        ["severity"] = diagnostic.Severity
                    });
                }

                fileDiagnostics.Add(new JObject
                {
                    ["filePath"] = group.Key,
                    ["diagnostics"] = entries
                });
            }

            return new JObject { ["fileDiagnostics"] = fileDiagnostics };
        }

        private static JObject ReadTextFile(JToken? parameters)
        {
            var path = GetStringParameter(parameters, "path");
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                return new JObject
                {
                    ["exists"] = false,
                    ["content"] = ""
                };
            }

            return new JObject
            {
                ["exists"] = true,
                ["content"] = File.ReadAllText(path)
            };
        }

        private static JObject WriteTextFile(JToken? parameters)
        {
            var path = GetStringParameter(parameters, "path");
            if (string.IsNullOrWhiteSpace(path))
                return new JObject { ["success"] = false };

            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            File.WriteAllText(path, GetStringParameter(parameters, "content"));
            return new JObject { ["success"] = true };
        }

        private static JObject CreateDirectory(JToken? parameters)
        {
            var path = GetStringParameter(parameters, "path");
            if (string.IsNullOrWhiteSpace(path))
                return new JObject { ["success"] = false };

            Directory.CreateDirectory(path);
            return new JObject { ["success"] = true };
        }

        private static JObject ListFiles(JToken? parameters)
        {
            var root = GetStringParameter(parameters, "path");
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            {
                return new JObject
                {
                    ["files"] = new JArray(),
                    ["truncated"] = false
                };
            }

            var recursive = parameters is JObject obj && obj.Value<bool?>("recursive") == true;
            var limit = Math.Max(1, GetIntParameter(parameters, "limit") ?? 5000);
            var option = recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
            var files = new JArray();
            var ignoreRules = LoadClineIgnoreRules(root);
            var count = 0;
            var truncated = false;

            try
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", option))
                {
                    if (ShouldSkipPath(entry) || IsIgnoredByClineIgnore(root, entry, ignoreRules))
                        continue;

                    if (count >= limit)
                    {
                        truncated = true;
                        break;
                    }

                    files.Add(entry);
                    count++;
                }
            }
            catch
            {
                truncated = true;
            }

            return new JObject
            {
                ["files"] = files,
                ["truncated"] = truncated
            };
        }

        private static JObject SearchFiles(JToken? parameters)
        {
            var root = GetStringParameter(parameters, "path");
            var query = GetStringParameter(parameters, "query");
            if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(query) || !Directory.Exists(root))
            {
                return new JObject
                {
                    ["matches"] = new JArray(),
                    ["truncated"] = false
                };
            }

            var limit = Math.Max(1, GetIntParameter(parameters, "limit") ?? 500);
            var matches = new JArray();
            var ignoreRules = LoadClineIgnoreRules(root);
            var count = 0;
            var truncated = false;

            try
            {
                foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
                {
                    if (ShouldSkipPath(file) || IsIgnoredByClineIgnore(root, file, ignoreRules))
                        continue;

                    if (count >= limit)
                    {
                        truncated = true;
                        break;
                    }

                    if (Path.GetFileName(file).IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
                        FileContains(file, query))
                    {
                        matches.Add(file);
                        count++;
                    }
                }
            }
            catch
            {
                truncated = true;
            }

            return new JObject
            {
                ["matches"] = matches,
                ["truncated"] = truncated
            };
        }

        private static string GetStringParameter(JToken? parameters, string name)
        {
            return parameters is JObject obj
                ? obj.Value<string>(name) ?? ""
                : "";
        }

        private static int? GetIntParameter(JToken? parameters, string name)
        {
            return parameters is JObject obj
                ? obj.Value<int?>(name)
                : null;
        }

        private async Task<JObject> ExecuteCommandInTerminalAsync(JToken? parameters)
        {
            var command = GetStringParameter(parameters, "command");
            if (string.IsNullOrWhiteSpace(command))
                return new JObject { ["success"] = false };

            var cwd = GetStringParameter(parameters, "cwd");
            if (string.IsNullOrWhiteSpace(cwd))
                cwd = await _editorService.GetSolutionRootAsync().ConfigureAwait(false) ?? _assemblyDirectory;

            var timeoutSeconds = GetIntParameter(parameters, "timeoutSeconds") ?? 60;
            var result = await _commandExecutionService.ExecuteCommandAsync(
                command,
                cwd,
                timeoutSeconds,
                CancellationToken.None).ConfigureAwait(false);

            return new JObject
            {
                ["success"] = !result.TimedOut && result.ExitCode == 0,
                ["exitCode"] = result.ExitCode,
                ["timedOut"] = result.TimedOut,
                ["stdout"] = TruncateCommandOutput(result.StdOut),
                ["stderr"] = TruncateCommandOutput(result.StdErr),
                ["stdoutTruncated"] = result.StdOut.Length > MaxCommandOutputChars,
                ["stderrTruncated"] = result.StdErr.Length > MaxCommandOutputChars
            };
        }

        private const int MaxCommandOutputChars = 12000;

        private static string TruncateCommandOutput(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= MaxCommandOutputChars)
                return value;

            return value.Substring(0, MaxCommandOutputChars)
                + Environment.NewLine
                + Environment.NewLine
                + $"[truncated {value.Length - MaxCommandOutputChars} chars]";
        }

        private async Task<JObject> CancelCommandsAsync()
        {
            var cancelled = await _commandExecutionService.CancelAllAsync().ConfigureAwait(false);
            return new JObject
            {
                ["cancelled"] = cancelled
            };
        }

        private async Task<JObject> OpenDiffAsync(JToken? parameters)
        {
            var leftPath = GetStringParameter(parameters, "leftPath");
            var rightPath = GetStringParameter(parameters, "rightPath");
            if (!string.IsNullOrWhiteSpace(leftPath) && !string.IsNullOrWhiteSpace(rightPath))
            {
                var args = QuoteVsCommandArgument(leftPath) + " " + QuoteVsCommandArgument(rightPath);
                await _editorService.ExecuteCommandAsync("Tools.DiffFiles", args).ConfigureAwait(false);
                return new JObject { ["success"] = true };
            }

            if (!string.IsNullOrWhiteSpace(leftPath))
                await _editorService.OpenFileAsync(leftPath).ConfigureAwait(false);

            if (!string.IsNullOrWhiteSpace(rightPath))
                await _editorService.OpenFileAsync(rightPath).ConfigureAwait(false);

            return new JObject { ["success"] = true };
        }

        private static string QuoteVsCommandArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void OpenExternal(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return;

            Process.Start(new ProcessStartInfo
            {
                FileName = value,
                UseShellExecute = true
            });
        }

        private static bool FileContains(string filePath, string query)
        {
            try
            {
                var info = new FileInfo(filePath);
                if (info.Length > 1024 * 1024)
                    return false;

                return File.ReadAllText(filePath)
                    .IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch
            {
                return false;
            }
        }

        private static bool ShouldSkipPath(string path)
        {
            var parts = path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return parts.Any(part =>
                string.Equals(part, ".git", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "node_modules", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "bin", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "obj", StringComparison.OrdinalIgnoreCase));
        }

        private sealed class ClineIgnoreRule
        {
            public string Pattern { get; set; } = "";
            public bool Negated { get; set; }
            public bool DirectoryOnly { get; set; }
            public bool Anchored { get; set; }
        }

        private static List<ClineIgnoreRule> LoadClineIgnoreRules(string root)
        {
            var rules = new List<ClineIgnoreRule>();
            try
            {
                var ignorePath = Path.Combine(root, ".clineignore");
                if (!File.Exists(ignorePath))
                    return rules;

                foreach (var rawLine in File.ReadAllLines(ignorePath))
                {
                    var line = rawLine.Trim();
                    if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
                        continue;

                    var negated = line.StartsWith("!", StringComparison.Ordinal);
                    if (negated)
                        line = line.Substring(1).Trim();

                    if (line.Length == 0)
                        continue;

                    line = line.Replace('\\', '/');
                    var anchored = line.StartsWith("/", StringComparison.Ordinal);
                    if (anchored)
                        line = line.TrimStart('/');

                    var directoryOnly = line.EndsWith("/", StringComparison.Ordinal);
                    if (directoryOnly)
                        line = line.TrimEnd('/');

                    if (line.Length > 0)
                    {
                        rules.Add(new ClineIgnoreRule
                        {
                            Pattern = line,
                            Negated = negated,
                            DirectoryOnly = directoryOnly,
                            Anchored = anchored
                        });
                    }
                }
            }
            catch
            {
            }

            return rules;
        }

        private static bool IsIgnoredByClineIgnore(string root, string path, List<ClineIgnoreRule> rules)
        {
            if (rules.Count == 0)
                return false;

            string relative;
            try
            {
                relative = GetRelativePath(root, path).Replace('\\', '/').TrimStart('/');
            }
            catch
            {
                return false;
            }

            if (relative.Length == 0 || relative.StartsWith("../", StringComparison.Ordinal) || relative == "..")
                return false;

            var isDirectory = Directory.Exists(path);
            var ignored = false;
            foreach (var rule in rules)
            {
                if (MatchesClineIgnoreRule(relative, isDirectory, rule))
                    ignored = !rule.Negated;
            }

            return ignored;
        }

        private static bool MatchesClineIgnoreRule(string relativePath, bool isDirectory, ClineIgnoreRule rule)
        {
            if (rule.DirectoryOnly && !isDirectory && relativePath.IndexOf("/", StringComparison.Ordinal) < 0)
                return false;

            var pattern = rule.Pattern;
            var hasSlash = pattern.IndexOf("/", StringComparison.Ordinal) >= 0;
            var hasWildcard = pattern.IndexOfAny(new[] { '*', '?' }) >= 0;

            if (!hasWildcard)
            {
                if (hasSlash || rule.Anchored)
                {
                    return string.Equals(relativePath, pattern, StringComparison.OrdinalIgnoreCase) ||
                           relativePath.StartsWith(pattern + "/", StringComparison.OrdinalIgnoreCase);
                }

                return relativePath.Split('/').Any(part => string.Equals(part, pattern, StringComparison.OrdinalIgnoreCase));
            }

			if (hasSlash || rule.Anchored)
				return WildcardMatch(relativePath, pattern) || WildcardMatch(relativePath, pattern + "/**");

            return relativePath.Split('/').Any(part => WildcardMatch(part, pattern));
        }

        private static bool WildcardMatch(string value, string pattern)
        {
            var regex = "^" + Regex.Escape(pattern)
                .Replace("\\*\\*", ".*")
                .Replace("\\*", "[^/]*")
                .Replace("\\?", "[^/]") + "$";

            return Regex.IsMatch(value, regex, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }

        private static string GetRelativePath(string root, string path)
        {
            var rootFullPath = EnsureTrailingDirectorySeparator(Path.GetFullPath(root));
            var pathFullPath = Path.GetFullPath(path);
            var rootUri = new Uri(rootFullPath);
            var pathUri = new Uri(pathFullPath);
            if (!string.Equals(rootUri.Scheme, pathUri.Scheme, StringComparison.OrdinalIgnoreCase))
                return pathFullPath;

            var relativeUri = rootUri.MakeRelativeUri(pathUri);
            return Uri.UnescapeDataString(relativeUri.ToString()).Replace('/', Path.DirectorySeparatorChar);
        }

        private static string EnsureTrailingDirectorySeparator(string path)
        {
            return path.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ||
                   path.EndsWith(Path.AltDirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? path
                : path + Path.DirectorySeparatorChar;
        }

        private static void InvokeOnUiThread(Action action)
        {
            var dispatcher = Application.Current?.Dispatcher;
            if (dispatcher == null || dispatcher.CheckAccess())
            {
                action();
                return;
            }

            dispatcher.Invoke(action);
        }

        private static T InvokeOnUiThread<T>(Func<T> action)
        {
            var dispatcher = Application.Current?.Dispatcher;
            if (dispatcher == null || dispatcher.CheckAccess())
                return action();

            return dispatcher.Invoke(action);
        }

        public void Dispose()
        {
            _client?.Dispose();
            _client = null;

            try
            {
                if (_process != null && !_process.HasExited)
                    _process.Kill();
            }
            catch
            {
            }

            _process?.Dispose();
            _process = null;
        }

        private static async Task ConnectWithRetryAsync(
            NamedPipeJsonRpcClient client,
            Process process,
            CancellationToken cancellationToken)
        {
            Exception? lastError = null;

            for (var attempt = 0; attempt < 30; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (process.HasExited)
                    throw new InvalidOperationException(
                        "Cline sidecar exited before the pipe connection was established. Exit code: " +
                        SafeExitCode(process));

                try
                {
                    await client.ConnectAsync(500, cancellationToken).ConfigureAwait(false);
                    return;
                }
                catch (Exception ex) when (!(ex is OperationCanceledException))
                {
                    lastError = ex;
                    await Task.Delay(100, cancellationToken).ConfigureAwait(false);
                }
            }

            throw new TimeoutException("Timed out while connecting to the Cline sidecar pipe.", lastError);
        }

        private static string PrepareSidecarRuntime(string packagedSidecarDirectory)
        {
            var nodeModulesZip = Path.Combine(packagedSidecarDirectory, "node_modules.zip");
            var cacheRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "Sidecar",
                "1.0.0");
            var nodeModulesDirectory = Path.Combine(cacheRoot, "node_modules");
            var stampPath = Path.Combine(cacheRoot, ".node_modules.stamp");
            var runtimeStampPath = Path.Combine(cacheRoot, ".runtime.stamp");
            var expectedStamp = GetArchiveStamp(nodeModulesZip);
            var expectedRuntimeStamp = GetRuntimeStamp(packagedSidecarDirectory);

            if (!File.Exists(runtimeStampPath) ||
                !string.Equals(File.ReadAllText(runtimeStampPath), expectedRuntimeStamp, StringComparison.Ordinal))
            {
                CopyRuntimeFiles(packagedSidecarDirectory, cacheRoot);
                File.WriteAllText(runtimeStampPath, expectedRuntimeStamp);
            }

            if (!Directory.Exists(nodeModulesDirectory) ||
                !File.Exists(stampPath) ||
                !string.Equals(File.ReadAllText(stampPath), expectedStamp, StringComparison.Ordinal))
            {
                if (!File.Exists(nodeModulesZip))
                    throw new FileNotFoundException("Cline SDK dependency archive was not found.", nodeModulesZip);

                Directory.CreateDirectory(cacheRoot);
                if (Directory.Exists(nodeModulesDirectory))
                    Directory.Delete(nodeModulesDirectory, true);

                ZipFile.ExtractToDirectory(nodeModulesZip, nodeModulesDirectory);
                File.WriteAllText(stampPath, expectedStamp);
            }

            return cacheRoot;
        }

        private static string GetRuntimeStamp(string sourceDirectory)
        {
            if (!Directory.Exists(sourceDirectory))
                return "missing";

            var builder = new StringBuilder();
            foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                var relativePath = file.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

                if (relativePath.StartsWith("node_modules", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(relativePath, "node.exe", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(relativePath, "node_modules.zip", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var info = new FileInfo(file);
                builder.Append(relativePath.Replace('\\', '/'))
                    .Append('|')
                    .Append(info.Length)
                    .Append('|')
                    .Append(info.LastWriteTimeUtc.Ticks)
                    .AppendLine();
            }

            return builder.ToString();
        }

        private static void CopyRuntimeFiles(string sourceDirectory, string targetDirectory)
        {
            Directory.CreateDirectory(targetDirectory);

            foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories))
            {
                var relativePath = file.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

                if (relativePath.StartsWith("node_modules", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(relativePath, "node.exe", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(relativePath, "node_modules.zip", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var targetPath = Path.Combine(targetDirectory, relativePath);
                var targetParent = Path.GetDirectoryName(targetPath);
                if (!string.IsNullOrWhiteSpace(targetParent))
                    Directory.CreateDirectory(targetParent);

                File.Copy(file, targetPath, true);
            }
        }

        private static string GetArchiveStamp(string archivePath)
        {
            if (!File.Exists(archivePath))
                return "missing";

            var info = new FileInfo(archivePath);
            return info.Length + ":" + info.LastWriteTimeUtc.Ticks;
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static string GetSidecarLogPath()
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "logs");
            Directory.CreateDirectory(directory);
            return Path.Combine(directory, "sidecar-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
        }

        private void CaptureSidecarLine(string prefix, string? line)
        {
            if (!string.IsNullOrEmpty(line))
            {
                var entry = DateTime.Now.ToString("HH:mm:ss.fff") + " [" + prefix + "] " + line;
                Debug.WriteLine(entry);
                lock (_recentOutputLock)
                {
                    _recentOutput.Enqueue(entry);
                    while (_recentOutput.Count > 80)
                        _recentOutput.Dequeue();
                }

                try
                {
                    if (!string.IsNullOrWhiteSpace(_logFilePath))
                        File.AppendAllText(_logFilePath!, entry + Environment.NewLine, Encoding.UTF8);
                }
                catch
                {
                }
            }
        }

        private string BuildStartupDiagnostic(string summary, Exception ex)
        {
            var builder = new StringBuilder();
            builder.Append(summary);
            builder.Append(" ");
            builder.Append(ex.Message);
            builder.Append(" Exception: ");
            builder.Append(ex);

            if (!string.IsNullOrWhiteSpace(_logFilePath))
            {
                builder.Append(" Log: ");
                builder.Append(_logFilePath);
            }

            string[] recent;
            lock (_recentOutputLock)
                recent = _recentOutput.ToArray();

            if (recent.Length > 0)
            {
                builder.Append(" Recent sidecar output: ");
                builder.Append(string.Join(" | ", recent.Skip(Math.Max(0, recent.Length - 12))));
            }

            return builder.ToString();
        }

        private static string SafeExitCode(Process? process)
        {
            try
            {
                return process == null || !process.HasExited
                    ? "running"
                    : process.ExitCode.ToString();
            }
            catch
            {
                return "unknown";
            }
        }
    }
}
