using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Host;

namespace VsClineAgent.Services
{
    internal sealed class VsCommandExecutionService : IDisposable
    {
        private const int MaxRetainedOutputChars = 200000;
        private const int MaxOutputHistoryLines = 1000;
        private const int MaxCommandHistoryItems = 100;
        private const int MaxShellSessionsPerCwd = 4;
        private static readonly Regex CompletionMarkerRegex = new Regex(
            @"(?:^|>)__VSCLINE_COMMAND_DONE__(?<id>cmd-\d{6})__(?<exit>-?\d+)$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex CurrentDirectoryMarkerRegex = new Regex(
            @"(?:^|>)__VSCLINE_COMMAND_CWD__(?<id>cmd-\d{6})__(?<cwd>.*)$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private readonly ICommandOutputWriter _outputWriter;
        private readonly int _maxShellSessionsPerCwd;
        private readonly ConcurrentDictionary<string, RunningCommandInfo> _activeCommands = new ConcurrentDictionary<string, RunningCommandInfo>();
        private readonly ConcurrentQueue<CommandOutputLine> _outputHistory = new ConcurrentQueue<CommandOutputLine>();
        private readonly ConcurrentQueue<CompletedCommandInfo> _commandHistory = new ConcurrentQueue<CompletedCommandInfo>();
        private readonly ConcurrentDictionary<string, List<TerminalShellSession>> _sessionsByCwd = new ConcurrentDictionary<string, List<TerminalShellSession>>(StringComparer.OrdinalIgnoreCase);
        private readonly object _cancellationLock = new object();
        private readonly CancellationTokenSource _shutdownCancellation = new CancellationTokenSource();
        private CancellationTokenSource _commandBatchCancellation = new CancellationTokenSource();
        private long _commandSequence;
        private long _outputSequence;
        private int _disposed;
        private readonly WindowsProcessJob _processJob = new WindowsProcessJob();

        public VsCommandExecutionService(ICommandOutputWriter? outputWriter = null, int maxShellSessionsPerCwd = MaxShellSessionsPerCwd)
        {
            _outputWriter = outputWriter ?? new NullCommandOutputWriter();
            _maxShellSessionsPerCwd = Math.Max(1, maxShellSessionsPerCwd);
        }

        public Task<bool> ShowOutputAsync()
        {
            return _outputWriter is ICommandOutputSurface surface
                ? surface.ShowAsync()
                : Task.FromResult(false);
        }

        public async Task<CommandExecutionResult> ExecuteCommandAsync(
            string command,
            string cwd,
            int timeoutSeconds,
            CancellationToken ct,
            string profileId = "visual-studio-command-host",
            bool reuseTerminal = true)
        {
            var commandId = "cmd-" + Interlocked.Increment(ref _commandSequence).ToString("D6");
            CancellationTokenSource linkedCts;
            CancellationToken batchCancellation;
            lock (_cancellationLock)
            {
                if (Volatile.Read(ref _disposed) != 0)
                    throw new ObjectDisposedException(nameof(VsCommandExecutionService));
                batchCancellation = _commandBatchCancellation.Token;
                linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
                    ct,
                    batchCancellation,
                    _shutdownCancellation.Token);
            }

            using var linkedCtsScope = linkedCts;

            var session = await AcquireSessionAsync(cwd, profileId, reuseTerminal, linkedCts.Token).ConfigureAwait(false);
            var terminalId = session.TerminalId;
            var startedAt = DateTimeOffset.UtcNow;
            var stopwatch = Stopwatch.StartNew();
            var runningInfo = new RunningCommandInfo
            {
                CommandId = commandId,
                TerminalId = terminalId,
                ProcessId = session.Process.Id,
                Process = session.Process,
                Command = command,
                WorkingDirectory = cwd,
                CurrentDirectory = session.CurrentDirectory,
                StartedAt = startedAt,
                Status = "running",
                IsReusableShell = session.IsReusable,
                IsHot = false,
                Shell = session.Shell,
            };
            var stdOut = new StringBuilder();
            var stdErr = new StringBuilder();
            runningInfo.StdOutBuffer = stdOut;
            runningInfo.StdErrBuffer = stdErr;
            var tcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            runningInfo.Completion = tcs;

            try
            {
                await _outputWriter.WriteLineAsync($"> [{commandId}] {command}");
                await _outputWriter.WriteLineAsync($"  Terminal: {terminalId}");
                await _outputWriter.WriteLineAsync($"  Working directory: {cwd}");

				lock (session.StateLock)
				{
					session.ActiveCommand = runningInfo;
					session.ActiveCompletion = tcs;
				}
                _activeCommands[commandId] = runningInfo;

                await SendCommandAsync(session, commandId, command, linkedCts.Token).ConfigureAwait(false);
                var observationWindow = Task.Delay(
                    TimeSpan.FromSeconds(Math.Max(1, timeoutSeconds)),
                    linkedCts.Token);
                await Task.WhenAny(tcs.Task, observationWindow);

                if (!tcs.Task.IsCompleted)
                {
					var transitioned = false;
					var cancelled = false;
					var terminateSession = false;
					lock (session.StateLock)
					{
						// The completion marker can arrive between WhenAny and this branch.
						// Only move to background while holding the same lock used by the
						// output callback, otherwise a completed command can remain active forever.
						if (!tcs.Task.IsCompleted)
						{
							transitioned = true;
							cancelled = linkedCts.IsCancellationRequested ||
								string.Equals(runningInfo.Status, "cancelled", StringComparison.OrdinalIgnoreCase);
							if (cancelled)
							{
								runningInfo.Status = "cancelled";
								session.IsDisposed = true;
								terminateSession = true;
							}
							else if (!session.Process.HasExited)
							{
								runningInfo.Status = "running";
								runningInfo.Background = true;
							}
							else
							{
								runningInfo.Status = "timedOut";
								session.IsDisposed = true;
								terminateSession = true;
							}
						}
					}

					if (!transitioned)
					{
						// Completion won the race; continue through the normal result path.
					}
					else
					{
						var cancellationOwnedByService = batchCancellation.IsCancellationRequested ||
							_shutdownCancellation.IsCancellationRequested;
						if (terminateSession && !cancellationOwnedByService)
							TryKill(session.Process);
                    stopwatch.Stop();
					var output = CaptureCommandOutput(runningInfo);
                    await _outputWriter.WriteLineAsync(cancelled
                        ? "  Command cancelled."
                        : runningInfo.Background
                            ? $"  Command is still running in background after {timeoutSeconds}s."
                            : $"  Command timed out after {timeoutSeconds}s.");
                    var result = new CommandExecutionResult
                    {
                        CommandId = commandId,
                        TerminalId = terminalId,
                        Status = runningInfo.Status,
                        TimedOut = !cancelled && !runningInfo.Background,
                        Cancelled = cancelled,
                        Background = runningInfo.Background,
                        IsHot = runningInfo.IsHot,
                        DurationMs = stopwatch.ElapsedMilliseconds,
                        CurrentDirectory = runningInfo.CurrentDirectory,
						StdOut = output.StdOut,
						StdErr = output.StdErr,
                        StdOutTruncated = runningInfo.StdOutTruncated,
                        StdErrTruncated = runningInfo.StdErrTruncated,
                    };
                    if (!runningInfo.Background)
                    {
                        RecordCompletedCommand(runningInfo, result);
                    }
                    return result;
					}
                }

                var exitCode = await tcs.Task;
                runningInfo.Status = string.Equals(runningInfo.Status, "cancelled", StringComparison.OrdinalIgnoreCase)
                    ? "cancelled"
                    : exitCode == 0 ? "completed" : "failed";
                stopwatch.Stop();
				var completedOutput = CaptureCommandOutput(runningInfo);
                await _outputWriter.WriteLineAsync($"  Exit code: {exitCode}");
                var completedResult = new CommandExecutionResult
                {
                    CommandId = commandId,
                    TerminalId = terminalId,
                    Status = runningInfo.Status,
                    ExitCode = exitCode,
                    Cancelled = string.Equals(runningInfo.Status, "cancelled", StringComparison.OrdinalIgnoreCase),
                    Background = runningInfo.Background,
                    IsHot = runningInfo.IsHot,
                    DurationMs = stopwatch.ElapsedMilliseconds,
                    CurrentDirectory = runningInfo.CurrentDirectory,
                    StdOut = completedOutput.StdOut,
                    StdErr = completedOutput.StdErr,
                    StdOutTruncated = runningInfo.StdOutTruncated,
                    StdErrTruncated = runningInfo.StdErrTruncated,
                };
                RecordCompletedCommand(runningInfo, completedResult);
                return completedResult;
            }
            catch (Exception) when (linkedCts.IsCancellationRequested)
            {
                var cancelled = ct.IsCancellationRequested || batchCancellation.IsCancellationRequested || _shutdownCancellation.IsCancellationRequested;
				lock (session.StateLock)
				{
					runningInfo.Status = cancelled ? "cancelled" : "timedOut";
					session.IsDisposed = true;
				}
				// A cancellation while a command is being written leaves the shell
				// protocol state unknown. Never return that shell to the reusable pool.
				// CancelAll/Dispose own process-tree termination; avoid waiting on the
				// same Process object concurrently from the command continuation.
				if (!batchCancellation.IsCancellationRequested && !_shutdownCancellation.IsCancellationRequested)
					TryKill(session.Process);
                stopwatch.Stop();
                var interruptedOutput = CaptureCommandOutput(runningInfo);
                var interruptedResult = new CommandExecutionResult
                {
                    CommandId = commandId,
                    TerminalId = terminalId,
                    Status = runningInfo.Status,
                    TimedOut = !cancelled,
                    Cancelled = cancelled,
                    IsHot = runningInfo.IsHot,
                    DurationMs = stopwatch.ElapsedMilliseconds,
                    CurrentDirectory = runningInfo.CurrentDirectory,
					StdOut = interruptedOutput.StdOut,
					StdErr = interruptedOutput.StdErr,
                    StdOutTruncated = runningInfo.StdOutTruncated,
                    StdErrTruncated = runningInfo.StdErrTruncated,
                };
                RecordCompletedCommand(runningInfo, interruptedResult);
                return interruptedResult;
            }
            finally
            {
                if (!runningInfo.Background)
                {
                    _activeCommands.TryRemove(commandId, out _);
					lock (session.StateLock)
                    {
						if (ReferenceEquals(session.ActiveCommand, runningInfo))
						{
							session.ActiveCommand = null;
							session.ActiveCompletion = null;
						}
                    }
                    ReleaseSession(session);
                }
            }
        }

        public Task<IReadOnlyList<TerminalProfileInfo>> GetAvailableProfilesAsync()
        {
            IReadOnlyList<TerminalProfileInfo> profiles = new[]
            {
                new TerminalProfileInfo
                {
                    Id = "visual-studio-command-host",
                    Name = "Visual Studio Developer Command Prompt",
                },
                new TerminalProfileInfo { Id = "visual-studio-developer-powershell", Name = "Visual Studio Developer PowerShell" },
                new TerminalProfileInfo { Id = "windows-command-prompt", Name = "Windows Command Prompt" },
                new TerminalProfileInfo { Id = "windows-powershell", Name = "Windows PowerShell" },
            };

            return Task.FromResult(profiles);
        }

        public Task<IReadOnlyList<RunningCommandInfo>> GetActiveCommandsAsync()
        {
            IReadOnlyList<RunningCommandInfo> commands = _activeCommands.Values
                .OrderBy(command => command.StartedAt)
                .ToList();
            return Task.FromResult(commands);
        }

        public Task<TerminalStateInfo> GetTerminalStateAsync()
        {
            var activeCommands = _activeCommands.Values
                .OrderBy(command => command.StartedAt)
                .ToList();
            var recentOutput = _outputHistory
                .OrderBy(line => line.Sequence)
                .ToList();
            var sessions = GetLiveSessions();
            var currentDirectory = activeCommands
                .Select(command => command.CurrentDirectory)
                .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                ?? sessions
                    .Select(session => session.CurrentDirectory)
                    .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                ?? string.Empty;
            var state = new TerminalStateInfo
            {
                ActiveCommands = activeCommands,
                BackgroundCommands = activeCommands
                    .Where(command => command.Background)
                    .ToList(),
                RecentCommands = _commandHistory
                    .OrderBy(command => command.StartedAt)
                    .ToList(),
                RecentOutput = recentOutput,
                OutputSequence = Interlocked.Read(ref _outputSequence),
                Shell = activeCommands.Select(command => command.Shell).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                    ?? sessions.Select(session => session.Shell).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                    ?? "cmd.exe",
                ShellState = TerminalCommandPolicy.BuildShellState(sessions.Count, sessions.Count(session => session.Busy)),
                ReuseMode = "reusable-cmd-session",
                CurrentDirectory = currentDirectory,
                UnretrievedOutputAvailable = recentOutput.Count > 0,
                Attachable = activeCommands.Count > 0,
                ProceedWhileRunningAvailable = activeCommands.Any(command => command.Background || command.IsHot),
            };
            return Task.FromResult(state);
        }

        public Task<IReadOnlyList<CommandOutputLine>> GetUnretrievedOutputAsync(long afterSequence)
        {
            IReadOnlyList<CommandOutputLine> lines = _outputHistory
                .Where(line => line.Sequence > afterSequence)
                .OrderBy(line => line.Sequence)
                .ToList();
            return Task.FromResult(lines);
        }

        public async Task<int> CancelAllAsync()
        {
            CancellationTokenSource pendingCommands;
            lock (_cancellationLock)
            {
                pendingCommands = _commandBatchCancellation;
                _commandBatchCancellation = new CancellationTokenSource();
            }
            try
            {
                pendingCommands.Cancel();
            }
            finally
            {
                pendingCommands.Dispose();
            }

            var commands = _activeCommands.Values.ToArray();
            var commandProcessIds = new Dictionary<string, int>(StringComparer.Ordinal);
            var processesById = new Dictionary<int, Process>();
            foreach (var command in commands)
            {
                var process = command.Process;
                if (process == null || !TryGetProcessId(process, out var processId))
                    continue;
                commandProcessIds[command.CommandId] = processId;
                processesById[processId] = process;
            }

            foreach (var command in commands)
            {
                command.Status = "cancelled";
                command.Completion?.TrySetCanceled();
            }
            var terminationTasks = processesById.ToDictionary(
                pair => pair.Key,
                pair => Task.Run(() => TryKill(pair.Value)));

            await Task.WhenAll(terminationTasks.Values).ConfigureAwait(false);

            var failedProcessIds = terminationTasks
                .Where(pair => !pair.Value.Result)
                .Select(pair => pair.Key)
                .ToArray();
            if (failedProcessIds.Length > 0)
                throw new InvalidOperationException("Failed to terminate terminal process(es): " + string.Join(", ", failedProcessIds));

            var cancelled = 0;
            foreach (var command in commands)
            {
                if (!commandProcessIds.TryGetValue(command.CommandId, out var processId) ||
                    !terminationTasks.ContainsKey(processId))
                    continue;

                cancelled++;
                AppendCommandOutput(command, "stderr", "Command cancelled by user.", new StringBuilder());
                await _outputWriter.WriteLineAsync($"  Command cancelled: {command.Command}");
            }

            return cancelled;
        }

        private static bool TryGetProcessId(Process process, out int processId)
        {
            try
            {
                processId = process.Id;
                return true;
            }
            catch
            {
                processId = 0;
                return false;
            }
        }

        private async Task<TerminalShellSession> AcquireSessionAsync(string cwd, string profileId, bool reuseTerminal, CancellationToken cancellationToken)
        {
            var normalizedCwd = string.IsNullOrWhiteSpace(cwd) ? Environment.CurrentDirectory : Path.GetFullPath(cwd);
            var normalizedProfileId = NormalizeProfileId(profileId);
            if (!reuseTerminal)
            {
                var isolated = CreateShellSession(normalizedCwd, normalizedProfileId, 1, false);
                isolated.Busy = true;
                return isolated;
            }

            var sessionKey = normalizedProfileId + "|" + normalizedCwd;
            var sessions = _sessionsByCwd.GetOrAdd(sessionKey, _ => new List<TerminalShellSession>());

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (Volatile.Read(ref _disposed) != 0)
                    throw new ObjectDisposedException(nameof(VsCommandExecutionService));

                TerminalShellSession? selected = null;
                TerminalShellSession[] expired;
                lock (sessions)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (Volatile.Read(ref _disposed) != 0)
                        throw new ObjectDisposedException(nameof(VsCommandExecutionService));

                    expired = sessions
                        .Where(session => session.IsDisposed || HasExited(session.Process))
                        .ToArray();
                    if (expired.Length > 0)
                    {
                        var expiredSet = new HashSet<TerminalShellSession>(expired);
                        sessions.RemoveAll(expiredSet.Contains);
                    }
                    selected = sessions.FirstOrDefault(session => !session.Busy);
                    if (selected == null && sessions.Count < _maxShellSessionsPerCwd)
                    {
                        selected = CreateShellSession(normalizedCwd, normalizedProfileId, sessions.Count + 1, true);
                        sessions.Add(selected);
                    }

                    if (selected != null)
                    {
                        selected.Busy = true;
                    }
                }

                // Process shutdown can invoke Exited callbacks that re-enter the
                // session registry, so never wait for a process while holding its list lock.
                foreach (var expiredSession in expired)
                    DisposeSession(expiredSession);

                if (selected != null)
                    return selected;

                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
            }
        }

        private TerminalShellSession CreateShellSession(string cwd, string profileId, int ordinal, bool reusable)
        {
            var profile = ResolveShellProfile(profileId);
            var terminalId = TerminalCommandPolicy.BuildTerminalId(cwd, ordinal, profile.Id);
            var psi = new ProcessStartInfo
            {
                FileName = profile.FileName,
                Arguments = profile.Arguments,
                WorkingDirectory = cwd,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var session = new TerminalShellSession
            {
                TerminalId = terminalId,
                ProfileId = profile.Id,
                Shell = profile.Shell,
                WorkingDirectory = cwd,
                CurrentDirectory = cwd,
                Process = process,
                IsReusable = reusable,
            };

            process.OutputDataReceived += (_, e) => HandleSessionOutput(session, "stdout", e.Data);
            process.ErrorDataReceived += (_, e) => HandleSessionOutput(session, "stderr", e.Data);
            process.Exited += (_, __) => CompleteBackgroundCommand(session, process.ExitCode, "shell-exited");

            process.Start();
            _processJob.Assign(process);
            if (!string.IsNullOrWhiteSpace(profile.InitializationCommand))
            {
                process.StandardInput.WriteLine(profile.InitializationCommand);
                process.StandardInput.Flush();
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return session;
        }

        private async Task SendCommandAsync(TerminalShellSession session, string commandId, string command, CancellationToken cancellationToken)
        {
            await session.InputLock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                var input = new StringBuilder().AppendLine(command);
                if (IsPowerShellProfile(session.ProfileId))
                {
                    input.AppendLine("$__vsclineSucceeded = $?");
                    input.AppendLine("$__vsclineExit = if ($__vsclineSucceeded) { 0 } elseif ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }");
                    input.AppendLine($"Write-Output \"__VSCLINE_COMMAND_CWD__{commandId}__$((Get-Location).Path)\"");
                    input.AppendLine($"Write-Output \"__VSCLINE_COMMAND_DONE__{commandId}__$__vsclineExit\"");
                }
                else
                {
                    input.AppendLine("set \"__VSCLINE_EXIT=%ERRORLEVEL%\"");
                    input.AppendLine($"echo __VSCLINE_COMMAND_CWD__{commandId}__%CD%");
                    input.AppendLine($"echo __VSCLINE_COMMAND_DONE__{commandId}__%__VSCLINE_EXIT%");
                }

                // FlushFileBuffers can wait until a long-running child command reads
                // the following marker lines. Queue the complete protocol payload in
                // one pipe write instead so the foreground observation window can start.
                var payload = Encoding.UTF8.GetBytes(input.ToString());
                await AwaitIoOrCancellationAsync(
                    () => session.Process.StandardInput.BaseStream.WriteAsync(payload, 0, payload.Length, cancellationToken),
                    cancellationToken).ConfigureAwait(false);
                var flushTask = session.Process.StandardInput.BaseStream.FlushAsync(cancellationToken);
                _ = flushTask.ContinueWith(
                    completed => { _ = completed.Exception; },
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
            finally
            {
                session.InputLock.Release();
            }
        }

        private static async Task AwaitIoOrCancellationAsync(Func<Task> ioOperation, CancellationToken cancellationToken)
        {
            var ioTask = ioOperation();
            if (ioTask.IsCompleted)
            {
                await ioTask.ConfigureAwait(false);
                return;
            }

            var cancellationTask = Task.Delay(Timeout.Infinite, cancellationToken);
            if (await Task.WhenAny(ioTask, cancellationTask).ConfigureAwait(false) == ioTask)
            {
                await ioTask.ConfigureAwait(false);
                return;
            }

            _ = ioTask.ContinueWith(
                completed => { _ = completed.Exception; },
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            cancellationToken.ThrowIfCancellationRequested();
        }

        private void HandleSessionOutput(TerminalShellSession session, string stream, string? text)
        {
            if (text == null)
                return;

            var marker = CompletionMarkerRegex.Match(text.Trim());
            if (stream == "stdout" && marker.Success)
            {
				RunningCommandInfo? command;
				lock (session.StateLock) command = session.ActiveCommand;
                if (command != null && string.Equals(command.CommandId, marker.Groups["id"].Value, StringComparison.Ordinal))
                {
                    if (int.TryParse(marker.Groups["exit"].Value, out var exitCode))
                    {
                        CompleteBackgroundCommand(session, exitCode, exitCode == 0 ? "completed" : "failed");
                    }
                }
                return;
            }

            var cwdMarker = CurrentDirectoryMarkerRegex.Match(text.Trim());
            if (stream == "stdout" && cwdMarker.Success)
            {
				RunningCommandInfo? command;
				lock (session.StateLock) command = session.ActiveCommand;
                if (command != null && string.Equals(command.CommandId, cwdMarker.Groups["id"].Value, StringComparison.Ordinal))
                {
                    var currentDirectory = cwdMarker.Groups["cwd"].Value.Trim();
                    if (!string.IsNullOrWhiteSpace(currentDirectory))
                    {
                        session.CurrentDirectory = currentDirectory;
                        command.CurrentDirectory = currentDirectory;
                    }
                }
                return;
            }

			RunningCommandInfo? active;
			lock (session.StateLock) active = session.ActiveCommand;
            if (active == null)
            {
                _outputHistory.Enqueue(new CommandOutputLine
                {
                    Sequence = Interlocked.Increment(ref _outputSequence),
                    CommandId = string.Empty,
                    TerminalId = session.TerminalId,
                    Stream = stream,
                    Text = text,
                    At = DateTimeOffset.UtcNow,
                });
                return;
            }

            AppendCommandOutput(active, stream, text, stream == "stderr" ? active.StdErrBuffer ?? new StringBuilder() : active.StdOutBuffer ?? new StringBuilder());
            _ = _outputWriter.WriteLineAsync(text);
        }

        private void CompleteBackgroundCommand(TerminalShellSession session, int exitCode, string status)
        {
			RunningCommandInfo? command;
			lock (session.StateLock)
			{
				command = session.ActiveCommand;
				if (command == null)
					return;

				command.Status = string.Equals(command.Status, "cancelled", StringComparison.OrdinalIgnoreCase)
					? "cancelled"
					: status;
				session.ActiveCompletion?.TrySetResult(exitCode);

				if (!command.Background)
					return;

				command.Background = false;
				session.ActiveCommand = null;
				session.ActiveCompletion = null;
			}

            var duration = (long)Math.Max(0, (DateTimeOffset.UtcNow - command.StartedAt).TotalMilliseconds);
            var output = CaptureCommandOutput(command);
            var result = new CommandExecutionResult
            {
                CommandId = command.CommandId,
                TerminalId = command.TerminalId,
                Status = command.Status,
                ExitCode = exitCode,
                TimedOut = false,
                Cancelled = string.Equals(command.Status, "cancelled", StringComparison.OrdinalIgnoreCase),
                Background = false,
                IsHot = command.IsHot,
                DurationMs = duration,
                CurrentDirectory = command.CurrentDirectory,
                StdOut = output.StdOut,
                StdErr = output.StdErr,
                StdOutTruncated = command.StdOutTruncated,
                StdErrTruncated = command.StdErrTruncated,
            };
            RecordCompletedCommand(command, result);
            _activeCommands.TryRemove(command.CommandId, out _);

            ReleaseSession(session);
        }

        private static string NormalizeProfileId(string profileId)
        {
            switch (profileId)
            {
                case "visual-studio-developer-powershell":
                case "windows-command-prompt":
                case "windows-powershell":
                case "visual-studio-command-host":
                    return profileId;
                default:
                    return "visual-studio-command-host";
            }
        }

        private static bool IsPowerShellProfile(string profileId)
        {
            return string.Equals(profileId, "visual-studio-developer-powershell", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(profileId, "windows-powershell", StringComparison.OrdinalIgnoreCase);
        }

        private static ShellProfileDefinition ResolveShellProfile(string profileId)
        {
            var normalized = NormalizeProfileId(profileId);
            if (IsPowerShellProfile(normalized))
            {
                var initialization = string.Empty;
                if (string.Equals(normalized, "visual-studio-developer-powershell", StringComparison.OrdinalIgnoreCase))
                {
                    var launchScript = FindVisualStudioTool("Launch-VsDevShell.ps1");
                    if (!string.IsNullOrWhiteSpace(launchScript))
                        initialization = "& '" + launchScript!.Replace("'", "''") + "' -SkipAutomaticLocation | Out-Null";
                }

                return new ShellProfileDefinition
                {
                    Id = normalized,
                    Shell = "powershell.exe",
                    FileName = "powershell.exe",
                    Arguments = "-NoLogo -NoProfile -NoExit -Command \"[Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new()\"",
                    InitializationCommand = initialization,
                };
            }

            var commandInitialization = string.Empty;
            if (string.Equals(normalized, "visual-studio-command-host", StringComparison.OrdinalIgnoreCase))
            {
                var developerCommand = FindVisualStudioTool("VsDevCmd.bat");
                if (!string.IsNullOrWhiteSpace(developerCommand))
                    commandInitialization = "call \"" + developerCommand + "\" -no_logo >nul";
            }

            return new ShellProfileDefinition
            {
                Id = normalized,
                Shell = "cmd.exe",
                FileName = "cmd.exe",
                Arguments = "/d /q /k chcp 65001 >nul",
                InitializationCommand = commandInitialization,
            };
        }

        private static string? FindVisualStudioTool(string fileName)
        {
            var candidates = new List<string>();
            var installDirectory = Environment.GetEnvironmentVariable("VSINSTALLDIR");
            if (!string.IsNullOrWhiteSpace(installDirectory))
                candidates.Add(Path.Combine(installDirectory, "Common7", "Tools", fileName));

            try
            {
                var processPath = Process.GetCurrentProcess().MainModule?.FileName;
                var ideDirectory = string.IsNullOrWhiteSpace(processPath) ? null : Path.GetDirectoryName(processPath);
                if (!string.IsNullOrWhiteSpace(ideDirectory))
                    candidates.Add(Path.GetFullPath(Path.Combine(ideDirectory!, "..", "Tools", fileName)));
            }
            catch
            {
            }

            return candidates.FirstOrDefault(File.Exists);
        }

        private void ReleaseSession(TerminalShellSession session)
        {
            var shouldDispose = !session.IsReusable || session.IsDisposed || HasExited(session.Process);
            if (!shouldDispose)
            {
                var sessionKey = session.ProfileId + "|" + session.WorkingDirectory;
                if (_sessionsByCwd.TryGetValue(sessionKey, out var sessions))
                {
                    lock (sessions)
                    {
                        if (sessions.Contains(session) && !session.IsDisposed && !HasExited(session.Process))
                            session.Busy = false;
                        else
                            shouldDispose = true;
                    }
                }
                else
                {
                    shouldDispose = true;
                }
            }

            if (shouldDispose)
                DisposeSession(session);
        }

		private static void DisposeInputLock(TerminalShellSession session)
		{
			if (Interlocked.Exchange(ref session.InputLockDisposed, 1) == 0)
				session.InputLock.Dispose();
		}

		private static void DisposeSession(TerminalShellSession session)
		{
			if (Interlocked.Exchange(ref session.ResourcesDisposed, 1) != 0)
				return;
			session.IsDisposed = true;
			TryKill(session.Process);
			try { session.Process.Dispose(); } catch { }
			DisposeInputLock(session);
		}

		private static bool HasExited(Process process)
		{
			try { return process.HasExited; }
			catch { return true; }
		}

        private sealed class ShellProfileDefinition
        {
            public string Id { get; set; } = string.Empty;
            public string Shell { get; set; } = string.Empty;
            public string FileName { get; set; } = string.Empty;
            public string Arguments { get; set; } = string.Empty;
            public string InitializationCommand { get; set; } = string.Empty;
        }

        private static bool TryKill(Process process)
        {
            int processId;
            try { processId = process.Id; }
            catch { return true; }

            try
            {
                if (!IsProcessRunning(processId))
                    return true;

                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                {
                    using var killer = Process.Start(new ProcessStartInfo
                    {
                        FileName = "taskkill.exe",
                        Arguments = "/PID " + processId + " /T /F",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    });
                    killer?.WaitForExit(3000);
                }

                if (WaitForProcessExit(processId, 2000))
                    return true;

                using var remaining = Process.GetProcessById(processId);
                remaining.Kill();
                remaining.WaitForExit(2000);
                return !IsProcessRunning(processId);
            }
            catch
            {
                // The Exited callback may dispose the original Process while this
                // method is waiting. The OS process table is the source of truth.
                return !IsProcessRunning(processId);
            }
        }

        private static bool WaitForProcessExit(int processId, int timeoutMilliseconds)
        {
            var stopwatch = Stopwatch.StartNew();
            while (stopwatch.ElapsedMilliseconds < timeoutMilliseconds)
            {
                if (!IsProcessRunning(processId))
                    return true;
                Thread.Sleep(25);
            }
            return !IsProcessRunning(processId);
        }

        private static bool IsProcessRunning(int processId)
        {
            try
            {
                using var candidate = Process.GetProcessById(processId);
                return !candidate.HasExited;
            }
            catch (ArgumentException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;
            _shutdownCancellation.Cancel();
            lock (_cancellationLock)
            {
                _commandBatchCancellation.Cancel();
            }

            foreach (var command in _activeCommands.Values)
            {
                command.Status = "cancelled";
                if (command.Process != null)
                    TryKill(command.Process);
            }

            var sessionsToDispose = new HashSet<TerminalShellSession>();
            foreach (var sessions in _sessionsByCwd.Values)
            {
                lock (sessions)
                {
                    foreach (var session in sessions)
                        sessionsToDispose.Add(session);
                    sessions.Clear();
                }
            }

            foreach (var session in sessionsToDispose)
                DisposeSession(session);

            _activeCommands.Clear();
            _sessionsByCwd.Clear();
            _processJob.Dispose();
            _commandBatchCancellation.Dispose();
            _shutdownCancellation.Dispose();
        }

        private void AppendCommandOutput(RunningCommandInfo command, string stream, string text, StringBuilder target)
        {
            lock (command.OutputLock)
            {
                if (target.Length + text.Length + Environment.NewLine.Length <= MaxRetainedOutputChars)
                {
                    target.AppendLine(text);
                }
                else if (stream == "stderr")
                {
                    command.StdErrTruncated = true;
                }
                else
                {
                    command.StdOutTruncated = true;
                }

                command.LastOutputAt = DateTimeOffset.UtcNow;
            }

            _outputHistory.Enqueue(new CommandOutputLine
            {
                Sequence = Interlocked.Increment(ref _outputSequence),
                CommandId = command.CommandId,
                TerminalId = command.TerminalId,
                Stream = stream,
                Text = text,
                At = DateTimeOffset.UtcNow,
            });

            while (_outputHistory.Count > MaxOutputHistoryLines && _outputHistory.TryDequeue(out _))
            {
            }
        }

        private static CommandOutputSnapshot CaptureCommandOutput(RunningCommandInfo command)
        {
            lock (command.OutputLock)
            {
                return new CommandOutputSnapshot(
                    command.StdOutBuffer?.ToString() ?? string.Empty,
                    command.StdErrBuffer?.ToString() ?? string.Empty);
            }
        }

        private sealed class CommandOutputSnapshot
        {
            public CommandOutputSnapshot(string stdOut, string stdErr)
            {
                StdOut = stdOut;
                StdErr = stdErr;
            }

            public string StdOut { get; }

            public string StdErr { get; }
        }

        private void RecordCompletedCommand(RunningCommandInfo command, CommandExecutionResult result)
        {
            _commandHistory.Enqueue(new CompletedCommandInfo
            {
                CommandId = command.CommandId,
                TerminalId = command.TerminalId,
                ProcessId = command.ProcessId,
                Command = command.Command,
                WorkingDirectory = command.WorkingDirectory,
                CurrentDirectory = command.CurrentDirectory,
                StartedAt = command.StartedAt,
                CompletedAt = DateTimeOffset.UtcNow,
                LastOutputAt = command.LastOutputAt,
                Status = result.Status,
                ExitCode = result.ExitCode,
                TimedOut = result.TimedOut,
                Cancelled = result.Cancelled,
                Background = result.Background,
                IsHot = result.IsHot,
                DurationMs = result.DurationMs,
                StdOutTruncated = result.StdOutTruncated,
                StdErrTruncated = result.StdErrTruncated,
            });

            while (_commandHistory.Count > MaxCommandHistoryItems && _commandHistory.TryDequeue(out _))
            {
            }
        }

        private List<TerminalShellSession> GetLiveSessions()
        {
            return _sessionsByCwd.Values.SelectMany(items =>
            {
                lock (items)
                {
                    return items.ToList();
                }
            }).Where(session => !session.IsDisposed && !session.Process.HasExited).ToList();
        }

    }

}
