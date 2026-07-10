using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of write_to_file tool from Cline
    // Overwrites the file with the provided content; creates directories as needed
    internal class WriteFileTool : IAgentTool
    {
        public string Name => "write_to_file";

        public async Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("path", out var relPath) || string.IsNullOrEmpty(relPath))
                return "Error: Missing required parameter 'path'";
            if (!parameters.TryGetValue("content", out var content))
                return "Error: Missing required parameter 'content'";

            string absPath = ResolvePath(cwd, relPath);
            bool exists = File.Exists(absPath);

            bool approved = await callbacks.AskApprovalAsync(
                $"{(exists ? "Overwrite" : "Create")} file: {relPath}",
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
                string dir = Path.GetDirectoryName(absPath);
                if (!string.IsNullOrEmpty(dir))
                    Directory.CreateDirectory(dir);

                await Task.Run(() =>
                    File.WriteAllText(absPath, content, new UTF8Encoding(false)), ct);

                int lineCount = content.Split('\n').Length;
                return $"The content was successfully saved to {relPath}. ({lineCount} lines)";
            }
            catch (Exception ex)
            {
                return $"Error writing file '{relPath}': {ex.Message}";
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
