using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of attempt_completion tool from Cline
    // Signals to the agent loop that the task is done
    internal class AttemptCompletionTool : IAgentTool
    {
        public string Name => "attempt_completion";

        public Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("result", out var result) || string.IsNullOrEmpty(result))
                return Task.FromResult("Error: Missing required parameter 'result'");

            parameters.TryGetValue("command", out var command);

            // Signal the agent loop that the task is complete
            callbacks.SignalCompletion(result, command ?? "");

            return Task.FromResult(result);
        }
    }
}
