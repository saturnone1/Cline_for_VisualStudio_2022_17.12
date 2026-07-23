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
using VsClineAgent.Host.Generated;
using VsClineAgent.Services;
using Microsoft.VisualStudio.Shell;

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
        private static readonly ConcurrentDictionary<int, WindowsProcessJob> OwnedJobs = new ConcurrentDictionary<int, WindowsProcessJob>();
        private static readonly ConcurrentDictionary<SidecarProcess, byte> OwnedInstances = new ConcurrentDictionary<SidecarProcess, byte>();
        private readonly WindowsProcessJob _processJob = new WindowsProcessJob();
        private int _disposed;
		public event Action<SidecarProcess>? Exited;
        private Func<object, Task>? _postToWebviewAsync;
        private readonly object _recentOutputLock = new object();
        private readonly Queue<string> _recentOutput = new Queue<string>();
        private string? _logFilePath;
        private int _unavailableNotificationSent;

        public SidecarProcess(
            string assemblyDirectory,
            VsEditorService editorService,
            VsCommandExecutionService commandExecutionService)
        {
            _assemblyDirectory = assemblyDirectory;
            _hostRpcRouter = HostRpcAdapterFactory.Create(
                assemblyDirectory,
                editorService,
                commandExecutionService,
                CaptureSidecarLine,
                () => _postToWebviewAsync);
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

            cancellationToken.ThrowIfCancellationRequested();
            var stopwatch = Stopwatch.StartNew();
            var pipeName = @"\\.\pipe\VsClineAgent-" + Guid.NewGuid().ToString("N");
            var sidecarDirectory = Path.Combine(_assemblyDirectory, "Sidecar");
            var runtimePreparation = _runtimeInstaller.Prepare(sidecarDirectory);
			cancellationToken.ThrowIfCancellationRequested();
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

			cancellationToken.ThrowIfCancellationRequested();

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

            var startedProcess = _process;
            try
            {
                _processJob.Assign(startedProcess);
                OwnedJobs[startedProcess.Id] = _processJob;
            }
            catch
            {
                try { startedProcess.Kill(); } catch { }
                throw;
            }
            startedProcess.Exited += (sender, args) =>
            {
                OwnedProcesses.TryRemove(startedProcess.Id, out _);
                OwnedInstances.TryRemove(this, out _);
                if (OwnedJobs.TryRemove(startedProcess.Id, out var completedJob))
                    completedJob.Dispose();
                CaptureSidecarLine("sidecar:exit", "exitCode=" + SafeExitCode(startedProcess));
				SignalUnavailable("process-exited", null);
            };
            OwnedProcesses[startedProcess.Id] = startedProcess;
            OwnedInstances[this] = 0;
            startedProcess.EnableRaisingEvents = true;
            startedProcess.OutputDataReceived += (_, e) => CaptureSidecarLine("sidecar", e.Data);
            startedProcess.ErrorDataReceived += (_, e) => CaptureSidecarLine("sidecar:error", e.Data);
            startedProcess.BeginOutputReadLine();
            startedProcess.BeginErrorReadLine();

            _client = new NamedPipeJsonRpcClient(pipeName);
            _client.RequestReceived += HandleSidecarRequestAsync;
            _client.ConnectionClosed += OnConnectionClosed;
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

		public async Task<string> WarmSdkAsync(CancellationToken cancellationToken)
		{
			var client = _client;
			if (!IsRunning || client == null)
				throw new InvalidOperationException("The LIG VS sidecar is not running.");

			var stopwatch = Stopwatch.StartNew();
			using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
			{
				timeout.CancelAfter(ReadSdkWarmupTimeoutMilliseconds());
				var result = await client.SendRequestAsync(
					"upstream.start",
					new { reason = "visual_studio_webview_ready" },
					timeout.Token).ConfigureAwait(false) as JObject;
				stopwatch.Stop();
				WriteSlowTrace("sidecar.sdkWarmup.slow", stopwatch.ElapsedMilliseconds, new JObject
				{
					["status"] = result?["status"]?.ToString() ?? "unknown"
				}, 1500);
				return result?["status"]?.ToString() ?? "unknown";
			}
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

        private void OnConnectionClosed(Exception error)
        {
            SignalUnavailable("transport-closed", error);
        }

        private void SignalUnavailable(string reason, Exception? error)
        {
            if (Volatile.Read(ref _disposed) != 0 || Interlocked.Exchange(ref _unavailableNotificationSent, 1) != 0)
                return;

            CaptureSidecarLine("sidecar:unavailable", reason + (error == null ? string.Empty : ": " + error.Message));
            try { Exited?.Invoke(this); }
            catch (Exception ex) { CaptureSidecarLine("sidecar:exit-notification", ex.Message); }
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;
			Exited = null;

            OwnedInstances.TryRemove(this, out _);

            var process = _process;
            var client = _client;
            if (client != null)
                client.ConnectionClosed -= OnConnectionClosed;
            if (client != null && process != null && !process.HasExited)
            {
                try
                {
					var graceMs = ReadShutdownGraceMilliseconds();
					using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(graceMs + 1000));
                    ThreadHelper.JoinableTaskFactory.Run(async delegate
                    {
						await client.SendRequestAsync("upstream.stop", new { reason = "visual_studio_host_dispose", graceMs }, timeout.Token);
                    });
					process.WaitForExit(graceMs + 1000);
                }
                catch (Exception ex)
                {
                    CaptureSidecarLine("sidecar:shutdown", "graceful stop failed: " + ex.Message);
                }
            }

            client?.Dispose();
            _client = null;
            try
            {
                if (process != null && !process.HasExited)
                {
                    OwnedProcesses.TryRemove(process.Id, out _);
                    if (OwnedJobs.TryRemove(process.Id, out var job))
                        job.Dispose();
                    if (!process.WaitForExit(1000))
                    {
                        process.Kill();
                        process.WaitForExit(2000);
                    }
                }
            }
            catch
            {
            }

            process?.Dispose();
            _process = null;
            _processJob.Dispose();
        }

		private static int ReadShutdownGraceMilliseconds()
		{
			var configured = Environment.GetEnvironmentVariable("VSCLINE_SIDECAR_SHUTDOWN_GRACE_MS");
			return int.TryParse(configured, out var value) && value >= 1000 && value <= 15000 ? value : 5000;
		}

        private static int ReadSdkWarmupTimeoutMilliseconds()
        {
            var configured = Environment.GetEnvironmentVariable("VSCLINE_SDK_WARMUP_TIMEOUT_MS");
            return int.TryParse(configured, out var value) && value >= 5000 && value <= 120000 ? value : 60000;
        }

        public static void DisposeAllRunning()
        {
            foreach (var instance in OwnedInstances.Keys.ToArray())
            {
                try { instance.Dispose(); } catch { }
            }

            foreach (var item in OwnedProcesses.ToArray())
            {
                if (!OwnedProcesses.TryRemove(item.Key, out var process))
                    continue;

                try
                {
                    if (OwnedJobs.TryRemove(item.Key, out var job))
                        job.Dispose();
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

            foreach (var item in OwnedJobs.ToArray())
            {
                if (OwnedJobs.TryRemove(item.Key, out var job))
                    job.Dispose();
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
