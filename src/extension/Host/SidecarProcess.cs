using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Adapters;
using VsClineAgent.Host.Generated;
using VsClineAgent.Services;

namespace VsClineAgent.Host
{
    internal sealed class SidecarProcess : IDisposable
    {
        private readonly string _assemblyDirectory;
        private readonly HostRpcRouter _hostRpcRouter;
		private readonly SidecarRuntimeInstaller _runtimeInstaller = new SidecarRuntimeInstaller();
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
            _hostRpcRouter = new HostRpcRouter(new IHostRpcAdapter[]
            {
                new HealthHostRpcAdapter(),
                new EnvironmentHostRpcAdapter(CaptureSidecarLine),
                new EditorHostRpcAdapter(editorService),
                new FileSystemHostRpcAdapter(),
                new TerminalHostRpcAdapter(assemblyDirectory, editorService, commandExecutionService),
                new DiffHostRpcAdapter(editorService),
                new WorkspaceHostRpcAdapter(editorService),
                new WebviewHostRpcAdapter(() => _postToWebviewAsync)
            });
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
                    protocolVersion = WebviewRpcContract.ProtocolVersion,
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
            if (responseProtocolVersion != WebviewRpcContract.ProtocolVersion)
            {
                throw new InvalidOperationException(
                    "Unsupported sidecar WebView protocol version. Expected " +
                    WebviewRpcContract.ProtocolVersion + ", received " +
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
            var runtimePreparation = _runtimeInstaller.Prepare(sidecarDirectory);
			WriteSlowTrace("sidecar.runtime.prepare.slow", runtimePreparation.TotalMs, new JObject
			{
				["runtime"] = runtimePreparation.RuntimeDirectory,
				["runtimeStampMs"] = runtimePreparation.RuntimeStampMs,
				["runtimeCopied"] = runtimePreparation.RuntimeCopied,
				["runtimeCopyMs"] = runtimePreparation.RuntimeCopyMs,
				["runtimeCopyReason"] = runtimePreparation.RuntimeCopyReason,
				["nodeModulesExtracted"] = runtimePreparation.NodeModulesExtracted,
				["nodeModulesExtractMs"] = runtimePreparation.NodeModulesExtractMs,
				["nodeModulesExtractReason"] = runtimePreparation.NodeModulesExtractReason
			});
            var runtimeDirectory = runtimePreparation.RuntimeDirectory;
            var scriptPath = Path.Combine(runtimeDirectory, "cline-sidecar.js");
            var nodePath = SidecarRuntimeInstaller.ResolveBundledNodePath(sidecarDirectory);
            _logFilePath = GetSidecarLogPath();

            if (!File.Exists(scriptPath))
                throw new FileNotFoundException(SidecarRuntimeInstaller.BuildMissingEntrypointDiagnostic(sidecarDirectory, runtimeDirectory), scriptPath);

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
                await SidecarStartupConnector.ConnectWithRetryAsync(
                    () => _process.HasExited,
                    () => SafeExitCode(_process),
                    (timeout, token) => _client.ConnectAsync(timeout, token),
                    cancellationToken).ConfigureAwait(false);
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
            return await _hostRpcRouter.HandleAsync(method, parameters).ConfigureAwait(false);
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
