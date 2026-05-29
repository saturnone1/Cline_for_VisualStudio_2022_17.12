using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of execute_command tool from Cline
    // VS 2022 wrapper: uses Process.Start(cmd.exe) in place of VS Code's terminal integration
    internal class ExecuteCommandTool : IAgentTool
    {
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
                    $"Execute command: {command}", ct);
                if (!approved)
                    return "The user denied this operation.";
            }

            callbacks.PostStatus($"$ {command}");

            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c {command}",
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            var stdOut = new StringBuilder();
            var stdErr = new StringBuilder();

            using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var tcs = new TaskCompletionSource<int>();
            process.Exited += (s, e) => tcs.TrySetResult(process.ExitCode);
            process.OutputDataReceived += (s, e) => { if (e.Data != null) stdOut.AppendLine(e.Data); };
            process.ErrorDataReceived += (s, e) => { if (e.Data != null) stdErr.AppendLine(e.Data); };

            try
            {
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();

                using var cts2 = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts2.CancelAfter(TimeSpan.FromSeconds(timeoutSec));

                await Task.WhenAny(tcs.Task, Task.Delay(-1, cts2.Token));

                if (!process.HasExited)
                {
                    try { process.Kill(); } catch { }
                    return $"Command timed out after {timeoutSec}s\n\nPartial output:\n{stdOut}";
                }

                int exitCode = await tcs.Task;

                var sb = new StringBuilder();
                if (stdOut.Length > 0)
                    sb.Append(stdOut);
                if (stdErr.Length > 0)
                {
                    if (sb.Length > 0) sb.AppendLine();
                    sb.Append(stdErr);
                }

                string output = sb.ToString().Trim();
                if (string.IsNullOrEmpty(output))
                    output = "(no output)";

                // Mirror Cline's format: command result with exit code
                return exitCode == 0
                    ? output
                    : $"Command failed with exit code {exitCode}:\n{output}";
            }
            catch (Exception ex) when (!(ex is OperationCanceledException))
            {
                return $"Error executing command: {ex.Message}";
            }
        }
    }
}
