using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of read_file tool from Cline
    // Returns content with "N | line" labels (Cline's read_file format)
    internal class ReadFileTool : IAgentTool
    {
        public string Name => "read_file";

        public async Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("path", out var relPath) || string.IsNullOrEmpty(relPath))
                return "Error: Missing required parameter 'path'";

            string absPath = ResolvePath(cwd, relPath);
            if (!File.Exists(absPath))
                return $"Error: File not found: {relPath}";

            try
            {
                string[] lines = await Task.Run(() => File.ReadAllLines(absPath, Encoding.UTF8), ct);
                int total = lines.Length;

                int from = 1;
                int to = Math.Min(total, 1000);

                if (parameters.TryGetValue("start_line", out var sl) && int.TryParse(sl, out int startLine))
                    from = Math.Max(1, startLine);
                if (parameters.TryGetValue("end_line", out var el) && int.TryParse(el, out int endLine))
                    to = Math.Min(total, endLine);
                else
                    to = Math.Min(total, from + 999);

                var sb = new StringBuilder();
                for (int i = from; i <= to; i++)
                    sb.AppendLine($"{i} | {lines[i - 1]}");

                if (to < total)
                    sb.AppendLine($"\n(File has {total} lines. Use start_line and end_line to read more sections.)");

                return sb.ToString();
            }
            catch (Exception ex)
            {
                return $"Error reading file '{relPath}': {ex.Message}";
            }
        }

        private static string ResolvePath(string cwd, string path)
        {
            if (Path.IsPathRooted(path)) return path;
            return Path.GetFullPath(Path.Combine(cwd, path));
        }
    }
}
