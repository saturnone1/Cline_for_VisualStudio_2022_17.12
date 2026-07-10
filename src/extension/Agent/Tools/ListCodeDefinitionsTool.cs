using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of list_code_definition_names tool from Cline
    // VS 2022 wrapper: uses regex-based parsing (Cline uses tree-sitter via Node.js)
    internal class ListCodeDefinitionsTool : IAgentTool
    {
        public string Name => "list_code_definition_names";

        // Language-specific patterns for extracting definitions
        private static readonly Dictionary<string, Regex[]> Patterns =
            new Dictionary<string, Regex[]>(StringComparer.OrdinalIgnoreCase)
            {
                [".cs"] = new[] {
                    new Regex(@"(?:public|private|protected|internal|static|abstract|sealed)[\w\s]*\s+(?:class|interface|enum|struct|record)\s+(\w+)", RegexOptions.Compiled),
                    new Regex(@"(?:public|private|protected|internal|static|override|virtual|abstract)\s+[\w<>\[\]]+\s+(\w+)\s*\(", RegexOptions.Compiled),
                },
                [".ts"] = new[] {
                    new Regex(@"(?:export\s+)?(?:class|interface|enum|type)\s+(\w+)", RegexOptions.Compiled),
                    new Regex(@"(?:export\s+)?(?:function|const|let|var)\s+(\w+)\s*(?:=\s*(?:async\s*)?\(|\()", RegexOptions.Compiled),
                },
                [".js"] = new[] {
                    new Regex(@"(?:export\s+)?(?:class|function)\s+(\w+)", RegexOptions.Compiled),
                    new Regex(@"(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(", RegexOptions.Compiled),
                },
                [".py"] = new[] {
                    new Regex(@"^(?:class|def|async def)\s+(\w+)", RegexOptions.Compiled | RegexOptions.Multiline),
                },
                [".java"] = new[] {
                    new Regex(@"(?:public|private|protected|static|abstract|final)[\w\s]*\s+(?:class|interface|enum)\s+(\w+)", RegexOptions.Compiled),
                    new Regex(@"(?:public|private|protected|static)\s+[\w<>\[\]]+\s+(\w+)\s*\(", RegexOptions.Compiled),
                },
                [".go"] = new[] {
                    new Regex(@"^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(", RegexOptions.Compiled | RegexOptions.Multiline),
                    new Regex(@"^type\s+(\w+)\s+(?:struct|interface)", RegexOptions.Compiled | RegexOptions.Multiline),
                },
            };

        public async Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("path", out var relPath) || string.IsNullOrEmpty(relPath))
                return "Error: Missing required parameter 'path'";

            string absPath = ResolvePath(cwd, relPath);
            if (!Directory.Exists(absPath))
                return $"Error: Directory not found: {relPath}";

            var sb = new StringBuilder();
            string[] files;
            try { files = Directory.GetFiles(absPath); }
            catch { return $"Error: Cannot read directory: {relPath}"; }

            foreach (var file in files)
            {
                if (ct.IsCancellationRequested) break;
                string ext = Path.GetExtension(file).ToLower();
                if (!Patterns.ContainsKey(ext)) continue;

                try
                {
                    string content = await Task.Run(() => File.ReadAllText(file, Encoding.UTF8), ct);
                    string[] lines = content.Split('\n');
                    var defs = new List<string>();

                    foreach (var pattern in Patterns[ext])
                    {
                        var matches = pattern.Matches(content);
                        foreach (Match m in matches)
                        {
                            // Find line number
                            int charIdx = m.Index;
                            int lineNum = 1;
                            for (int i = 0; i < content.Length && i < charIdx; i++)
                                if (content[i] == '\n') lineNum++;

                            defs.Add($"  {m.Groups[1].Value} (line {lineNum})");
                        }
                    }

                    if (defs.Count > 0)
                    {
                        sb.AppendLine(Path.GetFileName(file) + ":");
                        foreach (var d in defs) sb.AppendLine(d);
                        sb.AppendLine();
                    }
                }
                catch { /* skip unreadable files */ }
            }

            return sb.Length > 0 ? sb.ToString().TrimEnd() : $"No definitions found in {relPath}";
        }

        private static string ResolvePath(string cwd, string path)
        {
            if (path == ".") return cwd;
            if (Path.IsPathRooted(path)) return path;
            return Path.GetFullPath(Path.Combine(cwd, path));
        }
    }
}
