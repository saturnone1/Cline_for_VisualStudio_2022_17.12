using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Agent.Tools
{
    // Port of list_files tool from Cline
    internal class ListFilesTool : IAgentTool
    {
        private static readonly HashSet<string> IgnoredDirs = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase)
        {
            "bin", "obj", ".vs", ".git", "node_modules", ".next", "dist",
            "packages", "TestResults", ".idea", "__pycache__", ".svn",
        };

        public string Name => "list_files";

        public Task<string> ExecuteAsync(
            Dictionary<string, string> parameters,
            string cwd,
            IToolCallbacks callbacks,
            CancellationToken ct)
        {
            if (!parameters.TryGetValue("path", out var relPath) || string.IsNullOrEmpty(relPath))
                relPath = ".";

            bool recursive = parameters.TryGetValue("recursive", out var rec) &&
                             (rec.ToLower() == "true" || rec == "1");

            string absPath = ResolvePath(cwd, relPath);
            if (!Directory.Exists(absPath))
                return Task.FromResult($"Error: Directory not found: {relPath}");

            var sb = new StringBuilder();
            ListDirectory(absPath, absPath, sb, recursive, 0, ct);

            if (sb.Length == 0)
                sb.AppendLine("(empty directory)");

            return Task.FromResult(sb.ToString().TrimEnd());
        }

        private static void ListDirectory(string root, string dir, StringBuilder sb,
            bool recursive, int depth, CancellationToken ct)
        {
            if (ct.IsCancellationRequested) return;

            IEnumerable<string> entries;
            try
            {
                entries = Directory.GetFileSystemEntries(dir)
                    .OrderBy(e => Directory.Exists(e) ? 0 : 1)
                    .ThenBy(e => e);
            }
            catch { return; }

            foreach (var entry in entries)
            {
                if (ct.IsCancellationRequested) break;
                bool isDir = Directory.Exists(entry);
                string name = Path.GetFileName(entry);

                if (isDir && IgnoredDirs.Contains(name)) continue;

                string rel = entry.Substring(root.Length).TrimStart('\\', '/').Replace('\\', '/');
                sb.AppendLine(isDir ? rel + "/" : rel);

                if (isDir && recursive)
                    ListDirectory(root, entry, sb, recursive, depth + 1, ct);
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
