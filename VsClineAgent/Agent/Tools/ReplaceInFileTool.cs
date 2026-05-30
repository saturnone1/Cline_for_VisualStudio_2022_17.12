using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Agent.AssistantMessage;
using VsClineAgent.Agent.Prompts;

namespace VsClineAgent.Agent.Tools
{
    // Port of replace_in_file tool from Cline
    // Uses DiffApplier.Apply which ports constructNewFileContentV1 exactly
    internal class ReplaceInFileTool : IAgentTool
    {
        public string Name => "replace_in_file";

        public async Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("path", out var relPath) || string.IsNullOrEmpty(relPath))
                return "Error: Missing required parameter 'path'";
            if (!parameters.TryGetValue("diff", out var diff) || string.IsNullOrEmpty(diff))
                return FormatResponse.ReplaceInFileMissingDiffError(relPath);

            string absPath = ResolvePath(cwd, relPath);
            if (!File.Exists(absPath))
                return $"Error: File not found: {relPath}. Did you mean to use write_to_file to create it?";

            bool approved = await callbacks.AskApprovalAsync(
                $"Edit file: {relPath}",
                new ApprovalRequest
                {
                    Action = ApprovalAction.EditFiles,
                    TargetPath = absPath,
                    IsExternal = IsExternalToWorkspace(cwd, absPath),
                },
                ct);
            if (!approved)
                return "The user denied this operation.";

            try
            {
                string originalContent = await Task.Run(() =>
                    File.ReadAllText(absPath, Encoding.UTF8), ct);

                string newContent = DiffApplier.Apply(diff, originalContent, isFinal: true);

                await Task.Run(() =>
                    File.WriteAllText(absPath, newContent, new UTF8Encoding(false)), ct);

                // Return the final file state (mirrors Cline's behavior of returning updated content)
                string[] lines = newContent.Split('\n');
                var sb = new StringBuilder();
                for (int i = 0; i < lines.Length; i++)
                    sb.AppendLine($"{i + 1} | {lines[i]}");

                return $"The file {relPath} has been updated. Here's the result of running cat -n on it:\n{sb}";
            }
            catch (Exception ex)
            {
                return $"Error applying diff to '{relPath}': {ex.Message}";
            }
        }

        private static string ResolvePath(string cwd, string path)
        {
            if (Path.IsPathRooted(path)) return path;
            return Path.GetFullPath(Path.Combine(cwd, path));
        }

        private static bool IsExternalToWorkspace(string cwd, string path)
        {
            var workspaceRoot = Path.GetFullPath(cwd)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var fullPath = Path.GetFullPath(path);
            return !fullPath.StartsWith(workspaceRoot, StringComparison.OrdinalIgnoreCase);
        }
    }
}
