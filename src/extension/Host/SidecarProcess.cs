using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Adapters;
using VsClineAgent.Services;

namespace VsClineAgent.Host
{
    internal sealed class SidecarProcess : IDisposable
    {
        private const int WebviewProtocolVersion = 1;
        private readonly string _assemblyDirectory;
        private readonly HostRpcRouter _hostRpcRouter;
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
            var expectedStamp = SidecarRuntimeFingerprint.FromArchive(nodeModulesZip);
            var runtimeStampStopwatch = Stopwatch.StartNew();
            var expectedRuntimeStamp = SidecarRuntimeFingerprint.FromRuntimeDirectory(runtimeSourceDirectory);
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
