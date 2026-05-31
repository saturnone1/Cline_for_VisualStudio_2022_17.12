using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace VsClineAgent.Services
{
    internal sealed class VsCommandExecutionService
    {
        private static readonly Guid OutputPaneGuid = new Guid("A95D2F78-1D66-4E7D-B3B0-7E7193E129F1");
        private readonly ConcurrentDictionary<int, RunningCommandInfo> _activeCommands = new ConcurrentDictionary<int, RunningCommandInfo>();

        public async Task<CommandExecutionResult> ExecuteCommandAsync(
            string command,
            string cwd,
            int timeoutSeconds,
            CancellationToken ct)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/d /s /c \"{command}\"",
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                // cmd.exe emits text in the active Windows code page unless the
                // command changes it. Use the local code page so built-ins like
                // dir are readable on Korean Windows installations.
                StandardOutputEncoding = Encoding.Default,
                StandardErrorEncoding = Encoding.Default,
            };

            var stdOut = new StringBuilder();
            var stdErr = new StringBuilder();

            using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var tcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);

            process.Exited += (_, __) => tcs.TrySetResult(process.ExitCode);
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data == null)
                    return;

                stdOut.AppendLine(e.Data);
                _ = WriteLineAsync(e.Data);
            };
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data == null)
                    return;

                stdErr.AppendLine(e.Data);
                _ = WriteLineAsync(e.Data);
            };

            await WriteLineAsync($"> {command}");
            await WriteLineAsync($"  Working directory: {cwd}");

            process.Start();

            var runningInfo = new RunningCommandInfo
            {
                ProcessId = process.Id,
                Process = process,
                Command = command,
                WorkingDirectory = cwd,
                StartedAt = DateTimeOffset.UtcNow,
            };
            _activeCommands[process.Id] = runningInfo;

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            linkedCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

            try
            {
                await Task.WhenAny(tcs.Task, Task.Delay(Timeout.Infinite, linkedCts.Token));

                if (!process.HasExited)
                {
                    TryKill(process);
                    await WriteLineAsync($"  Command timed out after {timeoutSeconds}s.");
                    return new CommandExecutionResult
                    {
                        TimedOut = true,
                        StdOut = stdOut.ToString(),
                        StdErr = stdErr.ToString(),
                    };
                }

                var exitCode = await tcs.Task;
                await WriteLineAsync($"  Exit code: {exitCode}");
                return new CommandExecutionResult
                {
                    ExitCode = exitCode,
                    StdOut = stdOut.ToString(),
                    StdErr = stdErr.ToString(),
                };
            }
            finally
            {
                _activeCommands.TryRemove(process.Id, out _);
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

        public async Task<int> CancelAllAsync()
        {
            var cancelled = 0;
            foreach (var command in _activeCommands.Values)
            {
                var process = command.Process;
                if (process == null)
                    continue;

                try
                {
                    if (!process.HasExited)
                    {
                        TryKill(process);
                        cancelled++;
                        await WriteLineAsync($"  Command cancelled: {command.Command}");
                    }
                }
                catch
                {
                }
            }

            return cancelled;
        }

        private static void TryKill(Process process)
        {
            try
            {
                if (!process.HasExited)
                    process.Kill();
            }
            catch
            {
            }
        }

        private async Task WriteLineAsync(string text)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var pane = await GetOrCreatePaneAsync();
                pane?.OutputStringThreadSafe(text + Environment.NewLine);
            }
            catch
            {
            }
        }

        private static async Task<IVsOutputWindowPane?> GetOrCreatePaneAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

            var outputWindow = Package.GetGlobalService(typeof(SVsOutputWindow)) as IVsOutputWindow;
            if (outputWindow == null)
                return null;

            var outputPaneGuid = OutputPaneGuid;
            outputWindow.CreatePane(ref outputPaneGuid, "VsCline Agent", 1, 1);
            outputWindow.GetPane(ref outputPaneGuid, out var pane);
            pane?.Activate();
            return pane;
        }
    }

    internal sealed class TerminalProfileInfo
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
    }

    internal sealed class RunningCommandInfo
    {
        public int ProcessId { get; set; }
        public Process? Process { get; set; }
        public string Command { get; set; } = string.Empty;
        public string WorkingDirectory { get; set; } = string.Empty;
        public DateTimeOffset StartedAt { get; set; }
    }

    internal sealed class CommandExecutionResult
    {
        public int ExitCode { get; set; }
        public bool TimedOut { get; set; }
        public string StdOut { get; set; } = string.Empty;
        public string StdErr { get; set; } = string.Empty;
    }
}
