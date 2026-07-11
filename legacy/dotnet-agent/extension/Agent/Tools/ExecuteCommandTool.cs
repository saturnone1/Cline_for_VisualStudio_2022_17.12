using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of execute_command tool from Cline
    // VS 2022 wrapper: runs commands through a Visual Studio-hosted command service and mirrors output to the Output window.
    internal class ExecuteCommandTool : IAgentTool
    {
        private readonly Services.VsCommandExecutionService _commandService;

        public ExecuteCommandTool(Services.VsCommandExecutionService commandService)
        {
            _commandService = commandService;
        }

        public string Name => "execute_command";

        public async Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("command", out var command) || string.IsNullOrWhiteSpace(command))
                return "Error: Missing required parameter 'command'";

            parameters.TryGetValue("requires_approval", out var reqApproval);
            bool requiresApproval = reqApproval?.ToLower() == "true" || reqApproval == "1";

            int timeoutSec = 60;
            if (parameters.TryGetValue("timeout", out var to) && int.TryParse(to, out int t))
                timeoutSec = Math.Min(t, 600);

            if (requiresApproval)
            {
                bool approved = await callbacks.AskApprovalAsync(
                    $"Execute command: {command}",
                    new ApprovalRequest
                    {
                        Action = ApprovalAction.ExecuteCommand,
                        RequiresExplicitApproval = true,
                    },
                    ct);
                if (!approved)
                    return "The user denied this operation.";
            }
            else
            {
                bool approved = await callbacks.AskApprovalAsync(
                    $"Execute command: {command}",
                    new ApprovalRequest
                    {
                        Action = ApprovalAction.ExecuteCommand,
                        RequiresExplicitApproval = false,
                    },
                    ct);
                if (!approved)
                    return "The user denied this operation.";
            }

            callbacks.PostStatus($"$ {command}");

            try
            {
                var result = await _commandService.ExecuteCommandAsync(command, cwd, timeoutSec, ct);

                var sb = new StringBuilder();
                if (!string.IsNullOrWhiteSpace(result.StdOut))
                    sb.Append(result.StdOut);
                if (!string.IsNullOrWhiteSpace(result.StdErr))
                {
                    if (sb.Length > 0) sb.AppendLine();
                    sb.Append(result.StdErr);
                }

                string output = sb.ToString().Trim();
                if (string.IsNullOrEmpty(output))
                    output = "(no output)";

                if (result.TimedOut)
                    return $"Command timed out after {timeoutSec}s\n\nPartial output:\n{output}";

                // Mirror Cline's format: command result with exit code
                return result.ExitCode == 0
                    ? output
                    : $"Command failed with exit code {result.ExitCode}:\n{output}";
            }
            catch (Exception ex) when (!(ex is OperationCanceledException))
            {
                return $"Error executing command: {ex.Message}";
            }
        }
    }
}
