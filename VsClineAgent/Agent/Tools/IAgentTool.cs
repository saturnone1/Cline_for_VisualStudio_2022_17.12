using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    internal enum ApprovalAction
    {
        ReadFiles,
        EditFiles,
        ExecuteCommand,
        UseBrowser,
        UseMcp,
    }

    internal sealed class ApprovalRequest
    {
        public ApprovalAction Action { get; set; }
        public string TargetPath { get; set; } = "";
        public bool IsExternal { get; set; }
        public bool RequiresExplicitApproval { get; set; }
    }

    // Cline-style tool interface: params come from XML parsing, not JSON function calls
    internal interface IAgentTool
    {
        string Name { get; }
        Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct);
    }

    // Callbacks provided by AgentTask to tools for user interaction
    internal interface IToolCallbacks
    {
        // Ask user for approval (returns true = approved, false = denied)
        Task<bool> AskApprovalAsync(string toolDescription, ApprovalRequest request, CancellationToken ct);
        // Post a status message to the UI
        void PostStatus(string message);
        // Ask user a follow-up question (used by ask_followup_question)
        Task<string> AskUserAsync(string question, string[] options, CancellationToken ct);
        // Signals task completion (used by attempt_completion)
        void SignalCompletion(string result, string command);
    }
}
