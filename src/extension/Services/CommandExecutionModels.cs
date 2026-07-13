using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Services
{
    internal sealed class TerminalProfileInfo
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
    }

    internal sealed class RunningCommandInfo
    {
        public string CommandId { get; set; } = string.Empty;
        public string TerminalId { get; set; } = string.Empty;
        public int ProcessId { get; set; }
        public Process? Process { get; set; }
        public string Command { get; set; } = string.Empty;
        public string WorkingDirectory { get; set; } = string.Empty;
        public string CurrentDirectory { get; set; } = string.Empty;
        public DateTimeOffset StartedAt { get; set; }
        public DateTimeOffset? LastOutputAt { get; set; }
        public string Status { get; set; } = string.Empty;
        public bool StdOutTruncated { get; set; }
        public bool StdErrTruncated { get; set; }
        public bool IsReusableShell { get; set; }
        public bool IsHot { get; set; }
        public bool Background { get; set; }
        public bool Attachable => Background || string.Equals(Status, "running", StringComparison.OrdinalIgnoreCase);
        public bool ProceedWhileRunningAvailable => Background || IsHot;
        public string Shell { get; set; } = string.Empty;
        internal StringBuilder? StdOutBuffer { get; set; }
        internal StringBuilder? StdErrBuffer { get; set; }
        internal object OutputLock { get; } = new object();
    }

    internal sealed class CommandExecutionResult
    {
        public string CommandId { get; set; } = string.Empty;
        public string TerminalId { get; set; } = string.Empty;
        public string Status { get; set; } = string.Empty;
        public int ExitCode { get; set; }
        public bool TimedOut { get; set; }
        public bool Cancelled { get; set; }
        public bool Background { get; set; }
        public bool IsHot { get; set; }
        public long DurationMs { get; set; }
        public string CurrentDirectory { get; set; } = string.Empty;
        public string StdOut { get; set; } = string.Empty;
        public string StdErr { get; set; } = string.Empty;
        public bool StdOutTruncated { get; set; }
        public bool StdErrTruncated { get; set; }
    }

    internal sealed class TerminalStateInfo
    {
        public IReadOnlyList<RunningCommandInfo> ActiveCommands { get; set; } = Array.Empty<RunningCommandInfo>();
        public IReadOnlyList<RunningCommandInfo> BackgroundCommands { get; set; } = Array.Empty<RunningCommandInfo>();
        public IReadOnlyList<CompletedCommandInfo> RecentCommands { get; set; } = Array.Empty<CompletedCommandInfo>();
        public IReadOnlyList<CommandOutputLine> RecentOutput { get; set; } = Array.Empty<CommandOutputLine>();
        public long OutputSequence { get; set; }
        public string Shell { get; set; } = string.Empty;
        public string ShellState { get; set; } = string.Empty;
        public string ReuseMode { get; set; } = string.Empty;
        public string CurrentDirectory { get; set; } = string.Empty;
        public bool UnretrievedOutputAvailable { get; set; }
        public bool Attachable { get; set; }
        public bool ProceedWhileRunningAvailable { get; set; }
    }

    internal sealed class CompletedCommandInfo
    {
        public string CommandId { get; set; } = string.Empty;
        public string TerminalId { get; set; } = string.Empty;
        public int ProcessId { get; set; }
        public string Command { get; set; } = string.Empty;
        public string WorkingDirectory { get; set; } = string.Empty;
        public string CurrentDirectory { get; set; } = string.Empty;
        public DateTimeOffset StartedAt { get; set; }
        public DateTimeOffset CompletedAt { get; set; }
        public DateTimeOffset? LastOutputAt { get; set; }
        public string Status { get; set; } = string.Empty;
        public int ExitCode { get; set; }
        public bool TimedOut { get; set; }
        public bool Cancelled { get; set; }
        public bool Background { get; set; }
        public bool IsHot { get; set; }
        public long DurationMs { get; set; }
        public bool StdOutTruncated { get; set; }
        public bool StdErrTruncated { get; set; }
    }

    internal sealed class CommandOutputLine
    {
        public long Sequence { get; set; }
        public string CommandId { get; set; } = string.Empty;
        public string TerminalId { get; set; } = string.Empty;
        public string Stream { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty;
        public DateTimeOffset At { get; set; }
    }

    internal sealed class TerminalShellSession
    {
        public string TerminalId { get; set; } = string.Empty;
        public string WorkingDirectory { get; set; } = string.Empty;
        public string CurrentDirectory { get; set; } = string.Empty;
        public Process Process { get; set; } = null!;
        public bool Busy { get; set; }
        public bool IsDisposed { get; set; }
        public RunningCommandInfo? ActiveCommand { get; set; }
        public TaskCompletionSource<int>? ActiveCompletion { get; set; }
        public SemaphoreSlim InputLock { get; } = new SemaphoreSlim(1, 1);
    }
}
