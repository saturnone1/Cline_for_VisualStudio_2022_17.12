using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Services;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class TerminalHostRpcAdapter : IHostRpcAdapter
    {
        private readonly string _fallbackWorkingDirectory;
        private readonly VsEditorService _editorService;
        private readonly VsCommandExecutionService _commandExecutionService;

        public TerminalHostRpcAdapter(
            string fallbackWorkingDirectory,
            VsEditorService editorService,
            VsCommandExecutionService commandExecutionService)
        {
            _fallbackWorkingDirectory = fallbackWorkingDirectory;
            _editorService = editorService;
            _commandExecutionService = commandExecutionService;
        }

        public bool CanHandle(string method)
        {
            switch (method)
            {
                case "workspace.executeCommandInTerminal":
                case "workspace.cancelCommands":
                case "workspace.getTerminalState":
                case "workspace.getUnretrievedTerminalOutput":
                case "workspace.openTerminalPanel":
                case "workspace.attachTerminalCommand":
                case "workspace.continueTerminalCommand":
                    return true;
                default:
                    return false;
            }
        }

        public async Task<JToken?> HandleAsync(string method, JToken? parameters, CancellationToken cancellationToken = default(CancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            switch (method)
            {
                case "workspace.executeCommandInTerminal":
                    return await ExecuteCommandAsync(parameters, cancellationToken).ConfigureAwait(false);
                case "workspace.cancelCommands":
                    return new JObject
                    {
                        ["cancelled"] = await _commandExecutionService.CancelAllAsync().ConfigureAwait(false)
                    };
                case "workspace.getTerminalState":
                    return ToTerminalStateJson(await _commandExecutionService.GetTerminalStateAsync().ConfigureAwait(false));
                case "workspace.getUnretrievedTerminalOutput":
                    return await GetUnretrievedOutputAsync(parameters).ConfigureAwait(false);
                case "workspace.openTerminalPanel":
                    return await OpenTerminalPanelAsync(parameters).ConfigureAwait(false);
                case "workspace.attachTerminalCommand":
                    return await OpenCommandAsync(parameters, "Attached to Visual Studio command host output.").ConfigureAwait(false);
                case "workspace.continueTerminalCommand":
                    return await OpenCommandAsync(parameters, "Continuing while command runs in the Visual Studio command host.").ConfigureAwait(false);
                default:
                    throw new InvalidOperationException("Unsupported terminal host method: " + method);
            }
        }

        private async Task<JObject> ExecuteCommandAsync(JToken? parameters, CancellationToken cancellationToken)
        {
            var command = GetString(parameters, "command");
            if (string.IsNullOrWhiteSpace(command))
                return new JObject { ["success"] = false };

            var cwd = GetString(parameters, "cwd");
            if (string.IsNullOrWhiteSpace(cwd))
                cwd = await _editorService.GetSolutionRootAsync().ConfigureAwait(false) ?? _fallbackWorkingDirectory;

            var result = await _commandExecutionService.ExecuteCommandAsync(
                command,
                cwd,
                GetInt(parameters, "timeoutSeconds") ?? 600,
                cancellationToken,
                GetString(parameters, "profileId"),
                GetBool(parameters, "reuseTerminal") ?? true).ConfigureAwait(false);

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
                ["stdout"] = result.StdOut,
                ["stderr"] = result.StdErr,
                ["stdoutTruncated"] = result.StdOutTruncated,
                ["stderrTruncated"] = result.StdErrTruncated
            };
        }

        private async Task<JObject> GetUnretrievedOutputAsync(JToken? parameters)
        {
            var afterSequence = parameters is JObject values ? values.Value<long?>("afterSequence") ?? 0 : 0;
            var lines = await _commandExecutionService.GetUnretrievedOutputAsync(afterSequence).ConfigureAwait(false);
            return new JObject { ["lines"] = new JArray(lines.Select(ToCommandOutputJson)) };
        }

        private async Task<JObject> OpenTerminalPanelAsync(JToken? parameters)
        {
            var outputVisible = await _commandExecutionService.ShowOutputAsync().ConfigureAwait(false);
            var commandId = GetString(parameters, "commandId");
            var terminalId = GetString(parameters, "terminalId");
            return string.IsNullOrWhiteSpace(commandId) && string.IsNullOrWhiteSpace(terminalId)
                ? new JObject
                {
                    ["success"] = outputVisible,
                    ["message"] = outputVisible
                        ? "Visual Studio command output is visible."
                        : "The Visual Studio command output surface is unavailable."
                }
                : await BuildCommandActionResultAsync(
                    commandId,
                    terminalId,
                    outputVisible
                        ? "Visual Studio command output is visible."
                        : "The command is still tracked, but its Visual Studio output surface is unavailable.").ConfigureAwait(false);
        }

        private async Task<JObject> OpenCommandAsync(JToken? parameters, string message)
        {
            var outputVisible = await _commandExecutionService.ShowOutputAsync().ConfigureAwait(false);
            return await BuildCommandActionResultAsync(
                GetString(parameters, "commandId"),
                GetString(parameters, "terminalId"),
                outputVisible ? message : "The command is tracked, but its Visual Studio output surface is unavailable.").ConfigureAwait(false);
        }

        private async Task<JObject> BuildCommandActionResultAsync(string commandId, string terminalId, string message)
        {
            var state = await _commandExecutionService.GetTerminalStateAsync().ConfigureAwait(false);
            var active = state.ActiveCommands.FirstOrDefault(command => Matches(command.CommandId, command.TerminalId, commandId, terminalId));
            var completed = state.RecentCommands.LastOrDefault(command => Matches(command.CommandId, command.TerminalId, commandId, terminalId));
            var output = await _commandExecutionService.GetUnretrievedOutputAsync(Math.Max(0, state.OutputSequence - 200)).ConfigureAwait(false);
            var filteredOutput = output
                .Where(line => string.IsNullOrWhiteSpace(commandId) || string.Equals(line.CommandId, commandId, StringComparison.OrdinalIgnoreCase))
                .Where(line => string.IsNullOrWhiteSpace(terminalId) || string.Equals(line.TerminalId, terminalId, StringComparison.OrdinalIgnoreCase));
            var found = active != null || completed != null || string.IsNullOrWhiteSpace(commandId);

            return new JObject
            {
                ["success"] = found,
                ["message"] = found ? message : "No matching Visual Studio command host session was found.",
                ["command"] = active != null ? ToRunningCommandJson(active) : completed != null ? ToCompletedCommandJson(completed) : null,
                ["state"] = ToTerminalStateJson(state),
                ["lines"] = new JArray(filteredOutput.Select(ToCommandOutputJson))
            };
        }

        private static bool Matches(string candidateCommandId, string candidateTerminalId, string commandId, string terminalId)
        {
            return (string.IsNullOrWhiteSpace(commandId) || string.Equals(candidateCommandId, commandId, StringComparison.OrdinalIgnoreCase)) &&
                   (string.IsNullOrWhiteSpace(terminalId) || string.Equals(candidateTerminalId, terminalId, StringComparison.OrdinalIgnoreCase));
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
                ["commandId"] = command.CommandId, ["terminalId"] = command.TerminalId, ["processId"] = command.ProcessId,
                ["command"] = command.Command, ["cwd"] = command.WorkingDirectory, ["currentDirectory"] = command.CurrentDirectory,
                ["startedAt"] = command.StartedAt.ToString("O"), ["lastOutputAt"] = command.LastOutputAt?.ToString("O"),
                ["status"] = command.Status, ["isReusableShell"] = command.IsReusableShell, ["isHot"] = command.IsHot,
                ["background"] = command.Background, ["attachable"] = command.Attachable,
                ["proceedWhileRunningAvailable"] = command.ProceedWhileRunningAvailable, ["shell"] = command.Shell
            };
        }

        private static JObject ToCommandOutputJson(CommandOutputLine line)
        {
            return new JObject
            {
                ["sequence"] = line.Sequence, ["commandId"] = line.CommandId, ["terminalId"] = line.TerminalId,
                ["stream"] = line.Stream, ["text"] = line.Text, ["at"] = line.At.ToString("O")
            };
        }

        private static JObject ToCompletedCommandJson(CompletedCommandInfo command)
        {
            return new JObject
            {
                ["commandId"] = command.CommandId, ["terminalId"] = command.TerminalId, ["processId"] = command.ProcessId,
                ["command"] = command.Command, ["cwd"] = command.WorkingDirectory, ["currentDirectory"] = command.CurrentDirectory,
                ["startedAt"] = command.StartedAt.ToString("O"), ["completedAt"] = command.CompletedAt.ToString("O"),
                ["lastOutputAt"] = command.LastOutputAt?.ToString("O"), ["status"] = command.Status,
                ["exitCode"] = command.ExitCode, ["timedOut"] = command.TimedOut, ["cancelled"] = command.Cancelled,
                ["background"] = command.Background, ["isHot"] = command.IsHot, ["durationMs"] = command.DurationMs,
                ["stdoutTruncated"] = command.StdOutTruncated, ["stderrTruncated"] = command.StdErrTruncated
            };
        }

        private static string GetString(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<string>(name) ?? "" : "";
        }

        private static int? GetInt(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<int?>(name) : null;
        }

        private static bool? GetBool(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<bool?>(name) : null;
        }
    }
}
