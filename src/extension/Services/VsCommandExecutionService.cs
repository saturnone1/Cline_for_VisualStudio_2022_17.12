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
        private readonly ConcurrentDictionary<string, RunningCommandInfo> _activeCommands = new ConcurrentDictionary<string, RunningCommandInfo>();
        private readonly ConcurrentQueue<CommandOutputLine> _outputHistory = new ConcurrentQueue<CommandOutputLine>();
        private readonly ConcurrentQueue<CompletedCommandInfo> _commandHistory = new ConcurrentQueue<CompletedCommandInfo>();
        private readonly ConcurrentDictionary<string, List<TerminalShellSession>> _sessionsByCwd = new ConcurrentDictionary<string, List<TerminalShellSession>>(StringComparer.OrdinalIgnoreCase);
        private long _commandSequence;
        private long _outputSequence;
        private bool _disposed;
        private readonly WindowsProcessJob _processJob = new WindowsProcessJob();

        public VsCommandExecutionService(ICommandOutputWriter? outputWriter = null)
        {
            _outputWriter = outputWriter ?? new NullCommandOutputWriter();
        }

        public async Task<CommandExecutionResult> ExecuteCommandAsync(
            string command,
            string cwd,
            int timeoutSeconds,
            CancellationToken ct)
        {
            var commandId = "cmd-" + Interlocked.Increment(ref _commandSequence).ToString("D6");
            var session = await AcquireSessionAsync(cwd).ConfigureAwait(false);
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
                IsReusableShell = true,
                IsHot = TerminalCommandPolicy.IsLikelyLongRunning(command),
                Shell = "cmd.exe",
            };
            var stdOut = new StringBuilder();
            var stdErr = new StringBuilder();
            runningInfo.StdOutBuffer = stdOut;
            runningInfo.StdErrBuffer = stdErr;
            var tcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);

            await _outputWriter.WriteLineAsync($"> [{commandId}] {command}");
            await _outputWriter.WriteLineAsync($"  Terminal: {terminalId}");
            await _outputWriter.WriteLineAsync($"  Working directory: {cwd}");

            session.ActiveCommand = runningInfo;
            session.ActiveCompletion = tcs;
            _activeCommands[commandId] = runningInfo;

            await SendCommandAsync(session, commandId, command).ConfigureAwait(false);

            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            linkedCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

            try
            {
                await Task.WhenAny(tcs.Task, Task.Delay(Timeout.Infinite, linkedCts.Token));

                if (!tcs.Task.IsCompleted)
                {
                    var cancelled = ct.IsCancellationRequested || string.Equals(runningInfo.Status, "cancelled", StringComparison.OrdinalIgnoreCase);
                    if (cancelled)
                    {
                        TryKill(session.Process);
                        runningInfo.Status = "cancelled";
                    }
                    else if (runningInfo.IsHot)
                    {
                        runningInfo.Status = "running";
                        runningInfo.Background = true;
                    }
                    else
                    {
                        TryKill(session.Process);
                        runningInfo.Status = "timedOut";
                    }
                    stopwatch.Stop();
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
                        StdOut = stdOut.ToString(),
                        StdErr = stdErr.ToString(),
                        StdOutTruncated = runningInfo.StdOutTruncated,
                        StdErrTruncated = runningInfo.StdErrTruncated,
                    };
                    if (!runningInfo.Background)
                    {
                        RecordCompletedCommand(runningInfo, result);
                    }
                    return result;
                }

                var exitCode = await tcs.Task;
                runningInfo.Status = string.Equals(runningInfo.Status, "cancelled", StringComparison.OrdinalIgnoreCase)
                    ? "cancelled"
                    : exitCode == 0 ? "completed" : "failed";
                stopwatch.Stop();
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
                    StdOut = stdOut.ToString(),
                    StdErr = stdErr.ToString(),
                    StdOutTruncated = runningInfo.StdOutTruncated,
                    StdErrTruncated = runningInfo.StdErrTruncated,
                };
                RecordCompletedCommand(runningInfo, completedResult);
                return completedResult;
            }
            finally
            {
                if (!runningInfo.Background)
                {
                    _activeCommands.TryRemove(commandId, out _);
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
                    Name = "Visual Studio Command Host",
                },
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
                Shell = "cmd.exe",
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
            var commands = _activeCommands.Values.ToArray();
            var processes = commands
                .Select(command => command.Process)
                .Where(process => process != null)
                .GroupBy(process => process!.Id)
                .Select(group => group.First()!)
                .ToArray();
            var terminationTasks = processes.ToDictionary(
                process => process.Id,
                process => Task.Run(() => TryKill(process)));

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
                var process = command.Process;
                if (process == null || !terminationTasks.ContainsKey(process.Id))
                    continue;

                command.Status = "cancelled";
                cancelled++;
                AppendCommandOutput(command, "stderr", "Command cancelled by user.", new StringBuilder());
                await _outputWriter.WriteLineAsync($"  Command cancelled: {command.Command}");
            }

            return cancelled;
        }

        private async Task<TerminalShellSession> AcquireSessionAsync(string cwd)
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(VsCommandExecutionService));

            var normalizedCwd = string.IsNullOrWhiteSpace(cwd) ? Environment.CurrentDirectory : Path.GetFullPath(cwd);
            var sessions = _sessionsByCwd.GetOrAdd(normalizedCwd, _ => new List<TerminalShellSession>());

            while (true)
            {
                TerminalShellSession? selected = null;
                lock (sessions)
                {
                    sessions.RemoveAll(session => session.IsDisposed || session.Process.HasExited);
                    selected = sessions.FirstOrDefault(session => !session.Busy);
                    if (selected == null && sessions.Count < MaxShellSessionsPerCwd)
                    {
                        selected = CreateShellSession(normalizedCwd, sessions.Count + 1);
                        sessions.Add(selected);
                    }

                    if (selected != null)
                    {
                        selected.Busy = true;
                        return selected;
                    }
                }

                await Task.Delay(100).ConfigureAwait(false);
            }
        }

        private TerminalShellSession CreateShellSession(string cwd, int ordinal)
        {
            var terminalId = TerminalCommandPolicy.BuildTerminalId(cwd, ordinal);
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/d /q /k chcp 65001 >nul",
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
                WorkingDirectory = cwd,
                CurrentDirectory = cwd,
                Process = process,
            };

            process.OutputDataReceived += (_, e) => HandleSessionOutput(session, "stdout", e.Data);
            process.ErrorDataReceived += (_, e) => HandleSessionOutput(session, "stderr", e.Data);
            process.Exited += (_, __) => CompleteBackgroundCommand(session, process.ExitCode, "shell-exited");

            process.Start();
            _processJob.Assign(process);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return session;
        }

        private async Task SendCommandAsync(TerminalShellSession session, string commandId, string command)
        {
            await session.InputLock.WaitAsync().ConfigureAwait(false);
            try
            {
                await session.Process.StandardInput.WriteLineAsync(command).ConfigureAwait(false);
                await session.Process.StandardInput.WriteLineAsync("set \"__VSCLINE_EXIT=%ERRORLEVEL%\"").ConfigureAwait(false);
                await session.Process.StandardInput.WriteLineAsync($"echo __VSCLINE_COMMAND_CWD__{commandId}__%CD%").ConfigureAwait(false);
                await session.Process.StandardInput.WriteLineAsync($"echo __VSCLINE_COMMAND_DONE__{commandId}__%__VSCLINE_EXIT%").ConfigureAwait(false);
                await session.Process.StandardInput.FlushAsync().ConfigureAwait(false);
            }
            finally
            {
                session.InputLock.Release();
            }
        }

        private void HandleSessionOutput(TerminalShellSession session, string stream, string? text)
        {
            if (text == null)
                return;

            var marker = CompletionMarkerRegex.Match(text.Trim());
            if (stream == "stdout" && marker.Success)
            {
                var command = session.ActiveCommand;
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
                var command = session.ActiveCommand;
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

            var active = session.ActiveCommand;
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
            var command = session.ActiveCommand;
            if (command == null)
                return;

            command.Status = string.Equals(command.Status, "cancelled", StringComparison.OrdinalIgnoreCase)
                ? "cancelled"
                : status;
            session.ActiveCompletion?.TrySetResult(exitCode);

            if (!command.Background)
                return;

            command.Background = false;

            var duration = (long)Math.Max(0, (DateTimeOffset.UtcNow - command.StartedAt).TotalMilliseconds);
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
                StdOut = command.StdOutBuffer?.ToString() ?? string.Empty,
                StdErr = command.StdErrBuffer?.ToString() ?? string.Empty,
                StdOutTruncated = command.StdOutTruncated,
                StdErrTruncated = command.StdErrTruncated,
            };
            RecordCompletedCommand(command, result);
            _activeCommands.TryRemove(command.CommandId, out _);

            session.ActiveCommand = null;
            session.ActiveCompletion = null;
            ReleaseSession(session);
        }

        private static void ReleaseSession(TerminalShellSession session)
        {
            if (!session.Process.HasExited)
            {
                session.Busy = false;
            }
            else
            {
                session.IsDisposed = true;
            }
        }

        private static bool TryKill(Process process)
        {
            try
            {
                if (!process.HasExited)
                {
                    if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                    {
                        using var killer = Process.Start(new ProcessStartInfo
                        {
                            FileName = "taskkill.exe",
                            Arguments = "/PID " + process.Id + " /T /F",
                            UseShellExecute = false,
                            CreateNoWindow = true,
                        });
                        killer?.WaitForExit(3000);
                    }
                    if (!process.HasExited)
                    {
                        process.Kill();
                        process.WaitForExit(2000);
                    }
                }

                return process.HasExited;
            }
            catch
            {
                return false;
            }
        }

        public void Dispose()
        {
            if (_disposed)
                return;

            _disposed = true;

            foreach (var command in _activeCommands.Values)
            {
                command.Status = "cancelled";
                if (command.Process != null)
                    TryKill(command.Process);
            }

            foreach (var sessions in _sessionsByCwd.Values)
            {
                lock (sessions)
                {
                    foreach (var session in sessions)
                    {
                        session.IsDisposed = true;
                        TryKill(session.Process);
                        session.InputLock.Dispose();
                    }

                    sessions.Clear();
                }
            }

            _activeCommands.Clear();
            _sessionsByCwd.Clear();
            _processJob.Dispose();
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
