using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of ask_followup_question tool from Cline
    internal class AskFollowupQuestionTool : IAgentTool
    {
        public string Name => "ask_followup_question";

        public async Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("question", out var question) || string.IsNullOrEmpty(question))
                return "Error: Missing required parameter 'question'";

            parameters.TryGetValue("options", out var optionsJson);

            // Parse options array if provided (simple JSON array parsing)
            string[] options = System.Array.Empty<string>();
            if (!string.IsNullOrEmpty(optionsJson))
            {
                // Simple extraction: ["opt1", "opt2"] → ["opt1", "opt2"]
                var matches = System.Text.RegularExpressions.Regex.Matches(
                    optionsJson, @"""([^""]+)""");
                var list = new System.Collections.Generic.List<string>();
                foreach (System.Text.RegularExpressions.Match m in matches)
                    list.Add(m.Groups[1].Value);
                options = list.ToArray();
            }

            string answer = await callbacks.AskUserAsync(question, options, ct);
            return $"<answer>\n{answer}\n</answer>";
        }
    }
}
