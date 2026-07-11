using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Adapters;
using VsClineAgent.Services;

namespace VsClineAgent.Host
{
    internal sealed class SidecarProcess : IDisposable
    {
        private const int WebviewProtocolVersion = 1;
        private readonly string _assemblyDirectory;
        private readonly VsEditorService _editorService;
        private readonly VsCommandExecutionService _commandExecutionService;
        private readonly IHostRpcAdapter _environmentHostRpcAdapter;
        private Process? _process;
        private NamedPipeJsonRpcClient? _client;
        private static readonly ConcurrentDictionary<int, Process> OwnedProcesses = new ConcurrentDictionary<int, Process>();
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
            _environmentHostRpcAdapter = new EnvironmentHostRpcAdapter(CaptureSidecarLine);
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

            var stopwatch = Stopwatch.StartNew();
            var result = await _client.SendRequestAsync(
                "webview.message",
                new
                {
                    protocolVersion = WebviewProtocolVersion,
                    rawJson
                },
                cancellationToken).ConfigureAwait(false) as JObject;
            stopwatch.Stop();
            WriteSlowTrace("webview.message.slow", stopwatch.ElapsedMilliseconds, new JObject
            {
                ["rawLength"] = rawJson.Length,
                ["handled"] = result?.Value<bool?>("handled")
            });
            InteractionLog.Write("sidecar->host", "webview.message.result", result);

            if (result == null)
                return false;

            var responseProtocolVersion = result.Value<int?>("protocolVersion");
            if (responseProtocolVersion != WebviewProtocolVersion)
            {
                throw new InvalidOperationException(
                    "Unsupported sidecar WebView protocol version. Expected " +
                    WebviewProtocolVersion + ", received " +
                    (responseProtocolVersion?.ToString() ?? "missing") + ".");
            }

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

            var stopwatch = Stopwatch.StartNew();
            var pipeName = @"\\.\pipe\VsClineAgent-" + Guid.NewGuid().ToString("N");
            var sidecarDirectory = Path.Combine(_assemblyDirectory, "Sidecar");
            var runtimePreparation = PrepareSidecarRuntime(sidecarDirectory);
            var runtimeDirectory = runtimePreparation.RuntimeDirectory;
            var scriptPath = Path.Combine(runtimeDirectory, "cline-sidecar.js");
            var nodePath = ResolveBundledNodePath(sidecarDirectory);
            _logFilePath = GetSidecarLogPath();

            if (!File.Exists(scriptPath))
                throw new FileNotFoundException(BuildMissingEntrypointDiagnostic(sidecarDirectory, runtimeDirectory), scriptPath);

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
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false)
            };
            startInfo.EnvironmentVariables["LANG"] = "ko_KR.UTF-8";
            startInfo.EnvironmentVariables["LC_ALL"] = "ko_KR.UTF-8";

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
            OwnedProcesses[_process.Id] = _process;
            _process.Exited += (sender, args) =>
            {
                OwnedProcesses.TryRemove(_process.Id, out var removedProcess);
                CaptureSidecarLine("sidecar:exit", "exitCode=" + SafeExitCode(_process));
            };
            _process.OutputDataReceived += (_, e) => CaptureSidecarLine("sidecar", e.Data);
            _process.ErrorDataReceived += (_, e) => CaptureSidecarLine("sidecar:error", e.Data);
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            _client = new NamedPipeJsonRpcClient(pipeName);
            _client.RequestReceived += HandleSidecarRequestAsync;
            JToken? result;
            long pipeConnectMs = 0;
            long healthPingMs = 0;
            try
            {
                var pipeStopwatch = Stopwatch.StartNew();
                await ConnectWithRetryAsync(_client, _process, cancellationToken).ConfigureAwait(false);
                pipeStopwatch.Stop();
                pipeConnectMs = pipeStopwatch.ElapsedMilliseconds;

                var healthStopwatch = Stopwatch.StartNew();
                result = await _client.SendRequestAsync(
                    "health.ping",
                    new { client = "VsClineAgent", protocol = 1 },
                    cancellationToken).ConfigureAwait(false);
                healthStopwatch.Stop();
                healthPingMs = healthStopwatch.ElapsedMilliseconds;
            }
            catch (Exception ex)
            {
                Dispose();
                throw new InvalidOperationException(BuildStartupDiagnostic("Cline sidecar did not become ready.", ex), ex);
            }

            stopwatch.Stop();
            WriteSlowTrace("sidecar.start.slow", stopwatch.ElapsedMilliseconds, new JObject
            {
                ["status"] = ((JObject?)result)?["status"]?.ToString() ?? "unknown",
                ["runtime"] = runtimeDirectory,
                ["prepareRuntimeMs"] = runtimePreparation.TotalMs,
                ["runtimeStampMs"] = runtimePreparation.RuntimeStampMs,
                ["runtimeCopied"] = runtimePreparation.RuntimeCopied,
                ["runtimeCopyMs"] = runtimePreparation.RuntimeCopyMs,
                ["runtimeCopyReason"] = runtimePreparation.RuntimeCopyReason,
                ["nodeModulesExtracted"] = runtimePreparation.NodeModulesExtracted,
                ["nodeModulesExtractMs"] = runtimePreparation.NodeModulesExtractMs,
                ["nodeModulesExtractReason"] = runtimePreparation.NodeModulesExtractReason,
                ["pipeConnectMs"] = pipeConnectMs,
                ["healthPingMs"] = healthPingMs
            }, 1500);
            return ((JObject?)result)?["status"]?.ToString() ?? "unknown";
        }

        private static void WriteSlowTrace(string eventName, long durationMs, JObject payload, int thresholdMs = 750)
        {
            var configured = Environment.GetEnvironmentVariable("VSCLINE_SLOW_HOST_REQUEST_MS");
            if (int.TryParse(configured, out var parsed) && parsed > 0)
                thresholdMs = parsed;

            if (durationMs < thresholdMs)
                return;

            payload["durationMs"] = durationMs;
            payload["thresholdMs"] = thresholdMs;
            InteractionLog.Write("host", eventName, payload);
        }

        private async Task<JToken?> HandleSidecarRequestAsync(string method, JToken? parameters)
        {
            InteractionLog.Write("sidecar->host", method, parameters);
            if (_environmentHostRpcAdapter.CanHandle(method))
                return await _environmentHostRpcAdapter.HandleAsync(method, parameters).ConfigureAwait(false);

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
                case "workspace.deleteFile":
                    return DeleteFile(parameters);
                case "workspace.createDirectory":
                    return CreateDirectory(parameters);
                case "workspace.listFiles":
                    return ListFiles(parameters);
                case "workspace.searchFiles":
                    return SearchFiles(parameters);
                case "workspace.selectFiles":
                    return SelectFiles(parameters);
                case "window.showMessage":
                    await _editorService.SetStatusBarAsync(GetStringParameter(parameters, "message")).ConfigureAwait(false);
                    return new JObject { ["shown"] = true };
                case "window.openFile":
                    await _editorService.OpenFileAsync(
                        GetStringParameter(parameters, "filePath"),
                        GetIntParameter(parameters, "line")).ConfigureAwait(false);
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
                case "workspace.getTerminalState":
                    return await GetTerminalStateAsync().ConfigureAwait(false);
                case "workspace.getUnretrievedTerminalOutput":
                    return await GetUnretrievedTerminalOutputAsync(parameters).ConfigureAwait(false);
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
                    return await OpenTerminalPanelAsync(parameters).ConfigureAwait(false);
                case "workspace.attachTerminalCommand":
                    return await AttachTerminalCommandAsync(parameters).ConfigureAwait(false);
                case "workspace.continueTerminalCommand":
                    return await ContinueTerminalCommandAsync(parameters).ConfigureAwait(false);
                case "workspace.openSolution":
                    return await OpenSolutionAsync(parameters).ConfigureAwait(false);
                case "workspace.openFolder":
                    return await OpenFolderAsync(parameters).ConfigureAwait(false);
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

        private async Task<JObject> OpenSolutionAsync(JToken? parameters)
        {
            var solutionPath = GetStringParameter(parameters, "solutionPath");
            var newWindow = GetBoolParameter(parameters, "newWindow");
            if (string.IsNullOrWhiteSpace(solutionPath) || !File.Exists(solutionPath))
            {
                return new JObject
                {
                    ["success"] = false,
                    ["message"] = "Solution file was not found.",
                    ["solutionPath"] = solutionPath ?? ""
                };
            }

            try
            {
                if (newWindow)
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "devenv.exe",
                        Arguments = QuoteArgument(solutionPath),
                        UseShellExecute = true,
                        WindowStyle = ProcessWindowStyle.Normal
                    });
                }
                else
                {
                    await _editorService.OpenSolutionAsync(solutionPath).ConfigureAwait(false);
                }

                return new JObject
                {
                    ["success"] = true,
                    ["solutionPath"] = solutionPath,
                    ["newWindow"] = newWindow
                };
            }
            catch (Exception ex)
            {
                return new JObject
                {
                    ["success"] = false,
                    ["message"] = ex.Message,
                    ["solutionPath"] = solutionPath,
                    ["newWindow"] = newWindow
                };
            }
        }

        private async Task<JObject> OpenFolderAsync(JToken? parameters)
        {
            var folderPath = GetStringParameter(parameters, "folderPath");
            if (string.IsNullOrWhiteSpace(folderPath))
                folderPath = GetStringParameter(parameters, "path");
            var newWindow = GetBoolParameter(parameters, "newWindow");
            if (string.IsNullOrWhiteSpace(folderPath) || !Directory.Exists(folderPath))
            {
                return new JObject
                {
                    ["success"] = false,
                    ["message"] = "Folder was not found.",
                    ["folderPath"] = folderPath ?? ""
                };
            }

            try
            {
                if (newWindow)
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "devenv.exe",
                        Arguments = QuoteArgument(folderPath),
                        UseShellExecute = true,
                        WindowStyle = ProcessWindowStyle.Normal
                    });
                }
                else
                {
                    await _editorService.ExecuteCommandAsync("File.OpenFolder", QuoteVsCommandArgument(folderPath)).ConfigureAwait(false);
                }

                return new JObject
                {
                    ["success"] = true,
                    ["folderPath"] = folderPath,
                    ["newWindow"] = newWindow,
                    ["folderOnly"] = true
                };
            }
            catch (Exception ex)
            {
                return new JObject
                {
                    ["success"] = false,
                    ["message"] = ex.Message,
                    ["folderPath"] = folderPath,
                    ["newWindow"] = newWindow,
                    ["folderOnly"] = true
                };
            }
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

        private static JObject DeleteFile(JToken? parameters)
        {
            var path = GetStringParameter(parameters, "path");
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                return new JObject { ["success"] = false };

            File.Delete(path);
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
            var limit = Math.Max(1, GetIntParameter(parameters, "limit") ?? 1500);
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

            var limit = Math.Max(1, GetIntParameter(parameters, "limit") ?? 200);
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

        private static JObject SelectFiles(JToken? parameters)
        {
            var allowImages = GetBoolParameter(parameters, "allowImages") || GetBoolParameter(parameters, "value");
            return InvokeOnUiThread(() =>
            {
                var dialog = new OpenFileDialog
                {
                    Multiselect = true,
                    CheckFileExists = true,
                    Title = "Select files for LIG VS"
                };

                var imagePaths = new JArray();
                var filePaths = new JArray();

                if (dialog.ShowDialog() == true)
                {
                    foreach (var fileName in dialog.FileNames)
                    {
                        if (allowImages && IsImagePath(fileName))
                            imagePaths.Add(fileName);
                        else
                            filePaths.Add(fileName);
                    }
                }

                return new JObject
                {
                    ["values1"] = imagePaths,
                    ["values2"] = filePaths,
                    ["images"] = new JArray(imagePaths),
                    ["files"] = new JArray(filePaths)
                };
            });
        }

        private static bool IsImagePath(string path)
        {
            var extension = Path.GetExtension(path).ToLowerInvariant();
            return extension == ".png" ||
                   extension == ".jpg" ||
                   extension == ".jpeg" ||
                   extension == ".gif" ||
                   extension == ".webp" ||
                   extension == ".bmp";
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

        private static bool GetBoolParameter(JToken? parameters, string name)
        {
            return parameters is JObject obj && obj.Value<bool?>(name) == true;
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
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
                ["commandId"] = result.CommandId,
                ["terminalId"] = result.TerminalId,
                ["status"] = result.Status,
                ["success"] = !result.TimedOut && !result.Cancelled && result.ExitCode == 0,
                ["exitCode"] = result.ExitCode,
                ["timedOut"] = result.TimedOut,
                ["cancelled"] = result.Cancelled,
                ["background"] = result.Background,
                ["isHot"] = result.IsHot,
                ["attachable"] = result.Background,
                ["proceedWhileRunningAvailable"] = result.Background || result.IsHot,
                ["durationMs"] = result.DurationMs,
                ["currentDirectory"] = result.CurrentDirectory,
                ["stdout"] = TruncateCommandOutput(result.StdOut),
                ["stderr"] = TruncateCommandOutput(result.StdErr),
                ["stdoutTruncated"] = result.StdOutTruncated || result.StdOut.Length > MaxCommandOutputChars,
                ["stderrTruncated"] = result.StdErrTruncated || result.StdErr.Length > MaxCommandOutputChars
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

        private async Task<JObject> GetTerminalStateAsync()
        {
            var state = await _commandExecutionService.GetTerminalStateAsync().ConfigureAwait(false);
            return new JObject
            {
                ["activeCommands"] = new JArray(state.ActiveCommands.Select(ToRunningCommandJson)),
                ["backgroundCommands"] = new JArray(state.BackgroundCommands.Select(ToRunningCommandJson)),
                ["recentCommands"] = new JArray(state.RecentCommands.Select(ToCompletedCommandJson)),
                ["recentOutput"] = new JArray(state.RecentOutput.Select(ToCommandOutputJson)),
                ["outputSequence"] = state.OutputSequence,
                ["shell"] = state.Shell,
                ["shellState"] = state.ShellState,
                ["reuseMode"] = state.ReuseMode,
                ["currentDirectory"] = state.CurrentDirectory,
                ["unretrievedOutputAvailable"] = state.UnretrievedOutputAvailable,
                ["attachable"] = state.Attachable,
                ["proceedWhileRunningAvailable"] = state.ProceedWhileRunningAvailable
            };
        }

        private async Task<JObject> GetUnretrievedTerminalOutputAsync(JToken? parameters)
        {
            var afterSequence = parameters is JObject obj ? obj.Value<long?>("afterSequence") ?? 0 : 0;
            var lines = await _commandExecutionService.GetUnretrievedOutputAsync(afterSequence).ConfigureAwait(false);
            return new JObject
            {
                ["lines"] = new JArray(lines.Select(ToCommandOutputJson))
            };
        }

        private async Task<JObject> OpenTerminalPanelAsync(JToken? parameters)
        {
            await _editorService.ExecuteCommandAsync("View.Terminal").ConfigureAwait(false);
            var commandId = GetStringParameter(parameters, "commandId");
            var terminalId = GetStringParameter(parameters, "terminalId");
            if (!string.IsNullOrWhiteSpace(commandId) || !string.IsNullOrWhiteSpace(terminalId))
            {
                return await BuildTerminalCommandActionResultAsync(
                    commandId,
                    terminalId,
                    "Visual Studio command output pane was opened.").ConfigureAwait(false);
            }

            return new JObject { ["success"] = true };
        }

        private async Task<JObject> AttachTerminalCommandAsync(JToken? parameters)
        {
            await _editorService.ExecuteCommandAsync("View.Terminal").ConfigureAwait(false);
            return await BuildTerminalCommandActionResultAsync(
                GetStringParameter(parameters, "commandId"),
                GetStringParameter(parameters, "terminalId"),
                "Attached to Visual Studio command host output.").ConfigureAwait(false);
        }

        private async Task<JObject> ContinueTerminalCommandAsync(JToken? parameters)
        {
            await _editorService.ExecuteCommandAsync("View.Terminal").ConfigureAwait(false);
            return await BuildTerminalCommandActionResultAsync(
                GetStringParameter(parameters, "commandId"),
                GetStringParameter(parameters, "terminalId"),
                "Continuing while command runs in the Visual Studio command host.").ConfigureAwait(false);
        }

        private async Task<JObject> BuildTerminalCommandActionResultAsync(string commandId, string terminalId, string message)
        {
            var state = await _commandExecutionService.GetTerminalStateAsync().ConfigureAwait(false);
            var active = state.ActiveCommands.FirstOrDefault(command =>
                MatchesTerminalCommand(command.CommandId, command.TerminalId, commandId, terminalId));
            var completed = state.RecentCommands.LastOrDefault(command =>
                MatchesTerminalCommand(command.CommandId, command.TerminalId, commandId, terminalId));
            var afterSequence = Math.Max(0, state.OutputSequence - 200);
            var output = await _commandExecutionService.GetUnretrievedOutputAsync(afterSequence).ConfigureAwait(false);
            var filteredOutput = output
                .Where(line => string.IsNullOrWhiteSpace(commandId) || string.Equals(line.CommandId, commandId, StringComparison.OrdinalIgnoreCase))
                .Where(line => string.IsNullOrWhiteSpace(terminalId) || string.Equals(line.TerminalId, terminalId, StringComparison.OrdinalIgnoreCase))
                .ToList();

            return new JObject
            {
                ["success"] = active != null || completed != null || string.IsNullOrWhiteSpace(commandId),
                ["message"] = active != null || completed != null || string.IsNullOrWhiteSpace(commandId)
                    ? message
                    : "No matching Visual Studio command host session was found.",
                ["command"] = active != null
                    ? ToRunningCommandJson(active)
                    : completed != null
                        ? ToCompletedCommandJson(completed)
                        : null,
                ["state"] = ToTerminalStateJson(state),
                ["lines"] = new JArray(filteredOutput.Select(ToCommandOutputJson))
            };
        }

        private static bool MatchesTerminalCommand(string candidateCommandId, string candidateTerminalId, string commandId, string terminalId)
        {
            var commandMatches = string.IsNullOrWhiteSpace(commandId) ||
                string.Equals(candidateCommandId, commandId, StringComparison.OrdinalIgnoreCase);
            var terminalMatches = string.IsNullOrWhiteSpace(terminalId) ||
                string.Equals(candidateTerminalId, terminalId, StringComparison.OrdinalIgnoreCase);
            return commandMatches && terminalMatches;
        }

        private static JObject ToTerminalStateJson(TerminalStateInfo state)
        {
            return new JObject
            {
                ["activeCommands"] = new JArray(state.ActiveCommands.Select(ToRunningCommandJson)),
                ["backgroundCommands"] = new JArray(state.BackgroundCommands.Select(ToRunningCommandJson)),
                ["recentCommands"] = new JArray(state.RecentCommands.Select(ToCompletedCommandJson)),
                ["recentOutput"] = new JArray(state.RecentOutput.Select(ToCommandOutputJson)),
                ["outputSequence"] = state.OutputSequence,
                ["shell"] = state.Shell,
                ["shellState"] = state.ShellState,
                ["reuseMode"] = state.ReuseMode,
                ["currentDirectory"] = state.CurrentDirectory,
                ["unretrievedOutputAvailable"] = state.UnretrievedOutputAvailable,
                ["attachable"] = state.Attachable,
                ["proceedWhileRunningAvailable"] = state.ProceedWhileRunningAvailable
            };
        }

        private static JObject ToRunningCommandJson(RunningCommandInfo command)
        {
            return new JObject
            {
                ["commandId"] = command.CommandId,
                ["terminalId"] = command.TerminalId,
                ["processId"] = command.ProcessId,
                ["command"] = command.Command,
                ["cwd"] = command.WorkingDirectory,
                ["currentDirectory"] = command.CurrentDirectory,
                ["startedAt"] = command.StartedAt.ToString("O"),
                ["lastOutputAt"] = command.LastOutputAt?.ToString("O"),
                ["status"] = command.Status,
                ["isReusableShell"] = command.IsReusableShell,
                ["isHot"] = command.IsHot,
                ["background"] = command.Background,
                ["attachable"] = command.Attachable,
                ["proceedWhileRunningAvailable"] = command.ProceedWhileRunningAvailable,
                ["shell"] = command.Shell
            };
        }

        private static JObject ToCommandOutputJson(CommandOutputLine line)
        {
            return new JObject
            {
                ["sequence"] = line.Sequence,
                ["commandId"] = line.CommandId,
                ["terminalId"] = line.TerminalId,
                ["stream"] = line.Stream,
                ["text"] = line.Text,
                ["at"] = line.At.ToString("O")
            };
        }

        private static JObject ToCompletedCommandJson(CompletedCommandInfo command)
        {
            return new JObject
            {
                ["commandId"] = command.CommandId,
                ["terminalId"] = command.TerminalId,
                ["processId"] = command.ProcessId,
                ["command"] = command.Command,
                ["cwd"] = command.WorkingDirectory,
                ["currentDirectory"] = command.CurrentDirectory,
                ["startedAt"] = command.StartedAt.ToString("O"),
                ["completedAt"] = command.CompletedAt.ToString("O"),
                ["lastOutputAt"] = command.LastOutputAt?.ToString("O"),
                ["status"] = command.Status,
                ["exitCode"] = command.ExitCode,
                ["timedOut"] = command.TimedOut,
                ["cancelled"] = command.Cancelled,
                ["background"] = command.Background,
                ["isHot"] = command.IsHot,
                ["durationMs"] = command.DurationMs,
                ["stdoutTruncated"] = command.StdOutTruncated,
                ["stderrTruncated"] = command.StdErrTruncated
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
                string.Equals(part, ".vs", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, ".vscode", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "node_modules", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "bin", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "obj", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "dist", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "coverage", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "WebView2Runtime", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "Sidecar", StringComparison.OrdinalIgnoreCase));
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

            var process = _process;
            try
            {
                if (process != null && !process.HasExited)
                {
                    OwnedProcesses.TryRemove(process.Id, out _);
                    process.Kill();
                    process.WaitForExit(2000);
                }
            }
            catch
            {
            }

            process?.Dispose();
            _process = null;
        }

        public static void DisposeAllRunning()
        {
            foreach (var item in OwnedProcesses.ToArray())
            {
                if (!OwnedProcesses.TryRemove(item.Key, out var process))
                    continue;

                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill();
                        process.WaitForExit(2000);
                    }
                }
                catch
                {
                }
            }
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

        private sealed class SidecarRuntimePreparation
        {
            public string RuntimeDirectory { get; set; } = "";
            public long TotalMs { get; set; }
            public long RuntimeStampMs { get; set; }
            public bool RuntimeCopied { get; set; }
            public long RuntimeCopyMs { get; set; }
            public string RuntimeCopyReason { get; set; } = "";
            public bool NodeModulesExtracted { get; set; }
            public long NodeModulesExtractMs { get; set; }
            public string NodeModulesExtractReason { get; set; } = "";
        }

        private static SidecarRuntimePreparation PrepareSidecarRuntime(string packagedSidecarDirectory)
        {
            var totalStopwatch = Stopwatch.StartNew();
            var nodeModulesZip = Path.Combine(packagedSidecarDirectory, "node_modules.zip");
            var runtimeSourceDirectory = ResolvePackagedRuntimeDirectory(packagedSidecarDirectory);
            var runtimeVersion = GetRuntimeCacheVersion();
            var cacheRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "Sidecar",
                runtimeVersion);
            CleanupVersionedCacheDirectory(Path.GetDirectoryName(cacheRoot), runtimeVersion, 2);
            var nodeModulesDirectory = Path.Combine(cacheRoot, "node_modules");
            var stampPath = Path.Combine(cacheRoot, ".node_modules.stamp");
            var runtimeStampPath = Path.Combine(cacheRoot, ".runtime.stamp");
            var expectedStamp = GetArchiveStamp(nodeModulesZip);
            var runtimeStampStopwatch = Stopwatch.StartNew();
            var expectedRuntimeStamp = GetRuntimeStamp(runtimeSourceDirectory);
            runtimeStampStopwatch.Stop();

            var preparation = new SidecarRuntimePreparation
            {
                RuntimeDirectory = cacheRoot,
                RuntimeStampMs = runtimeStampStopwatch.ElapsedMilliseconds
            };

            var runtimeCopyReason = !File.Exists(runtimeStampPath)
                ? "missing_runtime_stamp"
                : !string.Equals(File.ReadAllText(runtimeStampPath), expectedRuntimeStamp, StringComparison.Ordinal)
                    ? "runtime_stamp_mismatch"
                    : "";
            if (!string.IsNullOrEmpty(runtimeCopyReason))
            {
                var runtimeCopyStopwatch = Stopwatch.StartNew();
                CopyRuntimeFiles(runtimeSourceDirectory, cacheRoot);
                runtimeCopyStopwatch.Stop();
                preparation.RuntimeCopied = true;
                preparation.RuntimeCopyMs = runtimeCopyStopwatch.ElapsedMilliseconds;
                preparation.RuntimeCopyReason = runtimeCopyReason;
                File.WriteAllText(runtimeStampPath, expectedRuntimeStamp);
            }

            var nodeModulesExtractReason = !Directory.Exists(nodeModulesDirectory)
                ? "missing_node_modules_directory"
                : !File.Exists(stampPath)
                    ? "missing_node_modules_stamp"
                    : !string.Equals(File.ReadAllText(stampPath), expectedStamp, StringComparison.Ordinal)
                        ? "node_modules_stamp_mismatch"
                        : "";
            if (!string.IsNullOrEmpty(nodeModulesExtractReason))
            {
                if (!File.Exists(nodeModulesZip))
                    throw new FileNotFoundException("Cline SDK dependency archive was not found.", nodeModulesZip);

                Directory.CreateDirectory(cacheRoot);
                if (Directory.Exists(nodeModulesDirectory))
                    Directory.Delete(nodeModulesDirectory, true);

                var extractStopwatch = Stopwatch.StartNew();
                ZipFile.ExtractToDirectory(nodeModulesZip, nodeModulesDirectory);
                extractStopwatch.Stop();
                preparation.NodeModulesExtracted = true;
                preparation.NodeModulesExtractMs = extractStopwatch.ElapsedMilliseconds;
                preparation.NodeModulesExtractReason = nodeModulesExtractReason;
                File.WriteAllText(stampPath, expectedStamp);
            }

            totalStopwatch.Stop();
            preparation.TotalMs = totalStopwatch.ElapsedMilliseconds;
            WriteSlowTrace("sidecar.runtime.prepare.slow", preparation.TotalMs, new JObject
            {
                ["runtime"] = preparation.RuntimeDirectory,
                ["runtimeStampMs"] = preparation.RuntimeStampMs,
                ["runtimeCopied"] = preparation.RuntimeCopied,
                ["runtimeCopyMs"] = preparation.RuntimeCopyMs,
                ["runtimeCopyReason"] = preparation.RuntimeCopyReason,
                ["nodeModulesExtracted"] = preparation.NodeModulesExtracted,
                ["nodeModulesExtractMs"] = preparation.NodeModulesExtractMs,
                ["nodeModulesExtractReason"] = preparation.NodeModulesExtractReason
            });
            return preparation;
        }

        private static string ResolvePackagedRuntimeDirectory(string packagedSidecarDirectory)
        {
            var rootEntrypoint = Path.Combine(packagedSidecarDirectory, "cline-sidecar.js");
            if (File.Exists(rootEntrypoint))
                return packagedSidecarDirectory;

            var nestedRuntimeDirectory = Path.Combine(packagedSidecarDirectory, "runtime");
            var nestedEntrypoint = Path.Combine(nestedRuntimeDirectory, "cline-sidecar.js");
            return File.Exists(nestedEntrypoint) ? nestedRuntimeDirectory : packagedSidecarDirectory;
        }

        private static string ResolveBundledNodePath(string packagedSidecarDirectory)
        {
            var rootNodePath = Path.Combine(packagedSidecarDirectory, "node.exe");
            if (File.Exists(rootNodePath))
                return rootNodePath;

            var runtimeNodePath = Path.Combine(packagedSidecarDirectory, "runtime", "node.exe");
            return File.Exists(runtimeNodePath) ? runtimeNodePath : "node";
        }

        private static string BuildMissingEntrypointDiagnostic(string packagedSidecarDirectory, string runtimeDirectory)
        {
            var packagedEntrypoint = Path.Combine(packagedSidecarDirectory, "cline-sidecar.js");
            var packagedRuntimeEntrypoint = Path.Combine(packagedSidecarDirectory, "runtime", "cline-sidecar.js");
            var cachedEntrypoint = Path.Combine(runtimeDirectory, "cline-sidecar.js");
            return "Cline sidecar entrypoint was not found. Checked: "
                + packagedEntrypoint
                + "; "
                + packagedRuntimeEntrypoint
                + "; "
                + cachedEntrypoint;
        }

        private static string GetRuntimeCacheVersion()
        {
            var configured = Environment.GetEnvironmentVariable("VSCLINE_SIDECAR_CACHE_KEY");
            string cacheVersion = string.IsNullOrWhiteSpace(configured)
                ? GetDefaultRuntimeCacheVersion()
                : configured!;

            foreach (var invalidChar in Path.GetInvalidFileNameChars())
                cacheVersion = cacheVersion.Replace(invalidChar, '_');

            return cacheVersion.Replace(' ', '_');
        }

        private static string GetDefaultRuntimeCacheVersion()
        {
            var assemblyName = Assembly.GetExecutingAssembly().GetName();
            var name = string.IsNullOrWhiteSpace(assemblyName.Name) ? "VsClineAgent" : assemblyName.Name!;
            var version = assemblyName.Version?.ToString() ?? "unknown";
            return name + "-" + version;
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
            using (var stream = File.OpenRead(archivePath))
            using (var sha256 = SHA256.Create())
            {
                var hash = sha256.ComputeHash(stream);
                return info.Length + ":sha256:" + BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
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
