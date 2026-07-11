using System.Text;

namespace VsClineAgent.Agent.Prompts
{
    // Port of formatResponse from /apps/vscode/src/core/prompts/responses.ts
    public static class FormatResponse
    {
        private static readonly string ToolUseInstructionsReminder =
            "Remember: use XML tags for tool use. For example:\n" +
            "<read_file>\n<path>path/to/file</path>\n</read_file>";

        public static string ToolDenied() => "The user denied this operation.";

        public static string ToolError(string error = null) =>
            $"The tool execution failed with the following error:\n<error>\n{error}\n</error>";

        public static string NoToolsUsed() =>
            $"[ERROR] You did not use a tool in your previous response! Please retry with a tool use.\n\n" +
            ToolUseInstructionsReminder +
            "\n\n# Next Steps\n\n" +
            "If you have completed the user's task, use the attempt_completion tool.\n" +
            "If you require additional information from the user, use the ask_followup_question tool.\n" +
            "Otherwise, if you have not completed the task and do not need additional information, then proceed with the next step of the task.\n" +
            "(This is an automated message, so do not respond to it conversationally.)";

        public static string MissingToolParameterError(string paramName) =>
            $"Missing value for required parameter '{paramName}'. Please retry with complete response.\n\n{ToolUseInstructionsReminder}";

        public static string ReplaceInFileMissingDiffError(string relPath) =>
            $"Failed to edit '{relPath}': The 'diff' parameter was empty.\n\n" +
            "The diff parameter must contain SEARCH/REPLACE blocks in this format:\n" +
            "------- SEARCH\n" +
            "exact lines to find\n" +
            "=======\n" +
            "replacement lines\n" +
            "+++++++ REPLACE\n\n" +
            "Rules:\n" +
            "- The SEARCH block must match existing file content exactly (including whitespace and indentation)\n" +
            "- You can include multiple SEARCH/REPLACE blocks in a single diff parameter\n" +
            "- If you're unsure of the exact content, use read_file first to see the current file";

        public static string ExecuteCommandMissingCommandError() =>
            "The 'command' parameter was empty. Provide the shell command to execute.\n\n" +
            "Example:\n" +
            "<execute_command>\n" +
            "<command>cd /path && python -m pytest tests/</command>\n" +
            "<requires_approval>false</requires_approval>\n" +
            "</execute_command>";

        public static string TooManyMistakes(string feedback = null) =>
            $"You seem to be having trouble proceeding. The user has provided the following feedback to help guide you:\n<feedback>\n{feedback}\n</feedback>";

        public static string FormatFilesList(string absolutePath, string[] files, bool didHitLimit)
        {
            var sb = new StringBuilder();
            foreach (var f in files)
            {
                string rel = f.Replace("\\", "/");
                if (rel.StartsWith(absolutePath.Replace("\\", "/")))
                    rel = rel.Substring(absolutePath.Replace("\\", "/").Length).TrimStart('/');
                sb.AppendLine(rel);
            }
            if (didHitLimit)
                sb.AppendLine("\n(File list was truncated. Use list_files with a specific path for more results.)");
            return sb.ToString().TrimEnd();
        }
    }
}
