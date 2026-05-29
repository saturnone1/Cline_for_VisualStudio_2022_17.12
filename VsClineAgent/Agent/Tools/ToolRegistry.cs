using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Agent.AssistantMessage;

namespace VsClineAgent.Agent.Tools
{
    // Port of the tool dispatch pattern from Cline's ToolExecutor/ToolExecutorCoordinator
    // Maps tool names to implementations and executes them with parsed XML params
    internal class ToolRegistry
    {
        private readonly Dictionary<string, IAgentTool> _tools =
            new Dictionary<string, IAgentTool>(StringComparer.OrdinalIgnoreCase);

        public void Register(IAgentTool tool) => _tools[tool.Name] = tool;

        public bool Has(string name) => _tools.ContainsKey(name);

        // Execute a parsed ToolUse block — mirrors ToolExecutor.execute() from Cline
        public async Task<string> ExecuteAsync(
            ToolUse block,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!_tools.TryGetValue(block.Name, out var tool))
                return $"Error: Unknown tool '{block.Name}'";

            try
            {
                return await tool.ExecuteAsync(block.Params, cwd, callbacks, ct);
            }
            catch (OperationCanceledException)
            {
                return "Tool execution was cancelled.";
            }
            catch (Exception ex)
            {
                return $"The tool execution failed with the following error:\n<error>\n{ex.Message}\n</error>";
            }
        }
    }
}
