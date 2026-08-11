using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of search_files tool from Cline
    internal class SearchFilesTool : IAgentTool
    {
        private static readonly HashSet<string> IgnoredDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "bin", "obj", ".vs", ".git", "node_modules", ".next", "dist",
            "packages", "TestResults", ".idea", "__pycache__", ".svn",
        };

        public string Name => "search_files";

        public async Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("path", out var relPath) || string.IsNullOrEmpty(relPath))
                return "Error: Missing required parameter 'path'";
            if (!parameters.TryGetValue("regex", out var pattern) || string.IsNullOrEmpty(pattern))
                return "Error: Missing required parameter 'regex'";

            parameters.TryGetValue("file_pattern", out var filePattern);

            string absPath = ResolvePath(cwd, relPath);
            if (!Directory.Exists(absPath))
                return $"Error: Directory not found: {relPath}";

            Regex regex;
            try
            {
                regex = new Regex(pattern, RegexOptions.Multiline | RegexOptions.IgnoreCase);
            }
            catch (Exception ex)
            {
                return $"Error: Invalid regex pattern: {ex.Message}";
            }

            string searchGlob = string.IsNullOrEmpty(filePattern) ? "*" : filePattern;

            var allFiles = await Task.Run(() => GetFiles(absPath, searchGlob).ToList(), ct);

            var results = new StringBuilder();
            int totalMatches = 0;
            const int maxResults = 300;

            foreach (var file in allFiles)
            {
                if (ct.IsCancellationRequested || totalMatches >= maxResults) break;
                try
                {
                    string content = await Task.Run(() => File.ReadAllText(file, Encoding.UTF8), ct);
                    string[] lines = content.Split('\n');

                    bool fileHasMatch = false;
                    for (int i = 0; i < lines.Length && totalMatches < maxResults; i++)
                    {
                        if (!regex.IsMatch(lines[i])) continue;

                        if (!fileHasMatch)
                        {
                            // Show relative path
                            string relFile = file.Length > absPath.Length
                                ? file.Substring(absPath.Length).TrimStart('\\', '/').Replace('\\', '/')
                                : file;
                            results.AppendLine($"# {relFile}");
                            fileHasMatch = true;
                        }

                        // Context: 2 lines before and after (mirrors Cline's output)
                        int contextStart = Math.Max(0, i - 2);
                        int contextEnd = Math.Min(lines.Length - 1, i + 2);

                        for (int c = contextStart; c <= contextEnd; c++)
                        {
                            string prefix = (c == i) ? ">" : " ";
                            results.AppendLine($"{prefix} {c + 1}: {lines[c]}");
                        }
                        results.AppendLine("----");
                        totalMatches++;
                    }

                    if (fileHasMatch) results.AppendLine();
                }
                catch { /* skip unreadable files */ }
            }

            if (totalMatches == 0)
                return $"No matches found for '{pattern}' in '{relPath}'";

            if (totalMatches >= maxResults)
                results.AppendLine($"\n(Results truncated at {maxResults} matches)");

            return results.ToString().TrimEnd();
        }

        private static IEnumerable<string> GetFiles(string root, string pattern)
        {
            var stack = new Stack<string>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                string dir = stack.Pop();
                if (IgnoredDirs.Contains(Path.GetFileName(dir))) continue;
                IEnumerable<string> files;
                try { files = Directory.GetFiles(dir, pattern); } catch { continue; }
                foreach (var f in files) yield return f;
                IEnumerable<string> subdirs;
                try { subdirs = Directory.GetDirectories(dir); } catch { continue; }
                foreach (var d in subdirs) stack.Push(d);
            }
        }

        private static string ResolvePath(string cwd, string path)
        {
            if (path == ".") return cwd;
            if (Path.IsPathRooted(path)) return path;
            return Path.GetFullPath(Path.Combine(cwd, path));
        }
    }
}
