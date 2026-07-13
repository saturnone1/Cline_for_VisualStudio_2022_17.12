using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class FileSystemHostRpcAdapter : IHostRpcAdapter
    {
        public bool CanHandle(string method)
        {
            switch (method)
            {
                case "host.fs.fileExists":
                case "workspace.fileExists":
                case "host.fs.readTextFile":
                case "workspace.readTextFile":
                case "workspace.writeTextFile":
                case "workspace.deleteFile":
                case "workspace.createDirectory":
                case "workspace.listFiles":
                case "workspace.searchFiles":
                case "workspace.selectFiles":
                    return true;
                default:
                    return false;
            }
        }

        public Task<JToken?> HandleAsync(string method, JToken? parameters)
        {
            JToken result;
            switch (method)
            {
                case "host.fs.fileExists":
                case "workspace.fileExists":
                    result = new JObject { ["exists"] = File.Exists(GetString(parameters, "path")) };
                    break;
                case "host.fs.readTextFile":
                case "workspace.readTextFile":
                    result = ReadTextFile(parameters);
                    break;
                case "workspace.writeTextFile":
                    result = WriteTextFile(parameters);
                    break;
                case "workspace.deleteFile":
                    result = DeleteFile(parameters);
                    break;
                case "workspace.createDirectory":
                    result = CreateDirectory(parameters);
                    break;
                case "workspace.listFiles":
                    result = ListFiles(parameters);
                    break;
                case "workspace.searchFiles":
                    result = SearchFiles(parameters);
                    break;
                case "workspace.selectFiles":
                    result = SelectFiles(parameters);
                    break;
                default:
                    throw new InvalidOperationException("Unsupported filesystem host method: " + method);
            }

            return Task.FromResult<JToken?>(result);
        }

        private static JObject ReadTextFile(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                return new JObject { ["exists"] = false, ["content"] = "" };

            return new JObject { ["exists"] = true, ["content"] = File.ReadAllText(path) };
        }

        private static JObject WriteTextFile(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path))
                return new JObject { ["success"] = false };

            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            File.WriteAllText(path, GetString(parameters, "content"));
            return new JObject { ["success"] = true };
        }

        private static JObject DeleteFile(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                return new JObject { ["success"] = false };

            File.Delete(path);
            return new JObject { ["success"] = true };
        }

        private static JObject CreateDirectory(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path))
                return new JObject { ["success"] = false };

            Directory.CreateDirectory(path);
            return new JObject { ["success"] = true };
        }

        private static JObject ListFiles(JToken? parameters)
        {
            var root = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            {
                return new JObject
                {
                    ["files"] = new JArray(),
                    ["truncated"] = false
                };
            }

            var recursive = parameters is JObject obj && obj.Value<bool?>("recursive") == true;
            var limit = Math.Max(1, GetInt(parameters, "limit") ?? 1500);
            var option = recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
            var files = new JArray();
            var ignoreRules = LoadClineIgnoreRules(root);
            var count = 0;
            var truncated = false;

            try
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", option))
                {
                    if (ShouldSkipPath(entry) || IsIgnoredByClineIgnore(root, entry, ignoreRules))
                        continue;

                    if (count >= limit)
                    {
                        truncated = true;
                        break;
                    }

                    files.Add(entry);
                    count++;
                }
            }
            catch
            {
                truncated = true;
            }

            return new JObject
            {
                ["files"] = files,
                ["truncated"] = truncated
            };
        }

        private static JObject SearchFiles(JToken? parameters)
        {
            var root = GetString(parameters, "path");
            var query = GetString(parameters, "query");
            if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(query) || !Directory.Exists(root))
            {
                return new JObject
                {
                    ["matches"] = new JArray(),
                    ["truncated"] = false
                };
            }

            var limit = Math.Max(1, GetInt(parameters, "limit") ?? 200);
            var matches = new JArray();
            var ignoreRules = LoadClineIgnoreRules(root);
            var count = 0;
            var truncated = false;

            try
            {
                foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
                {
                    if (ShouldSkipPath(file) || IsIgnoredByClineIgnore(root, file, ignoreRules))
                        continue;

                    if (count >= limit)
                    {
                        truncated = true;
                        break;
                    }

                    if (Path.GetFileName(file).IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
                        FileContains(file, query))
                    {
                        matches.Add(file);
                        count++;
                    }
                }
            }
            catch
            {
                truncated = true;
            }

            return new JObject
            {
                ["matches"] = matches,
                ["truncated"] = truncated
            };
        }

        private static JObject SelectFiles(JToken? parameters)
        {
            var allowImages = GetBool(parameters, "allowImages") || GetBool(parameters, "value");
            return InvokeOnUiThread(() =>
            {
                var dialog = new OpenFileDialog
                {
                    Multiselect = true,
                    CheckFileExists = true,
                    Title = "Select files for LIG VS"
                };

                var imagePaths = new JArray();
                var filePaths = new JArray();

                if (dialog.ShowDialog() == true)
                {
                    foreach (var fileName in dialog.FileNames)
                    {
                        if (allowImages && IsImagePath(fileName))
                            imagePaths.Add(fileName);
                        else
                            filePaths.Add(fileName);
                    }
                }

                return new JObject
                {
                    ["values1"] = imagePaths,
                    ["values2"] = filePaths,
                    ["images"] = new JArray(imagePaths),
                    ["files"] = new JArray(filePaths)
                };
            });
        }

        private static bool IsImagePath(string path)
        {
            var extension = Path.GetExtension(path).ToLowerInvariant();
            return extension == ".png" ||
                   extension == ".jpg" ||
                   extension == ".jpeg" ||
                   extension == ".gif" ||
                   extension == ".webp" ||
                   extension == ".bmp";
        }

        private static bool FileContains(string filePath, string query)
        {
            try
            {
                var info = new FileInfo(filePath);
                if (info.Length > 1024 * 1024)
                    return false;

                return File.ReadAllText(filePath)
                    .IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch
            {
                return false;
            }
        }

        private static bool ShouldSkipPath(string path)
        {
            var parts = path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return parts.Any(part =>
                string.Equals(part, ".git", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, ".vs", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, ".vscode", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "node_modules", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "bin", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "obj", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "dist", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "coverage", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "WebView2Runtime", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(part, "Sidecar", StringComparison.OrdinalIgnoreCase));
        }

        private sealed class ClineIgnoreRule
        {
            public string Pattern { get; set; } = "";
            public bool Negated { get; set; }
            public bool DirectoryOnly { get; set; }
            public bool Anchored { get; set; }
        }

        private static List<ClineIgnoreRule> LoadClineIgnoreRules(string root)
        {
            var rules = new List<ClineIgnoreRule>();
            try
            {
                var ignorePath = Path.Combine(root, ".clineignore");
                if (!File.Exists(ignorePath))
                    return rules;

                foreach (var rawLine in File.ReadAllLines(ignorePath))
                {
                    var line = rawLine.Trim();
                    if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
                        continue;

                    var negated = line.StartsWith("!", StringComparison.Ordinal);
                    if (negated)
                        line = line.Substring(1).Trim();

                    if (line.Length == 0)
                        continue;

                    line = line.Replace('\\', '/');
                    var anchored = line.StartsWith("/", StringComparison.Ordinal);
                    if (anchored)
                        line = line.TrimStart('/');

                    var directoryOnly = line.EndsWith("/", StringComparison.Ordinal);
                    if (directoryOnly)
                        line = line.TrimEnd('/');

                    if (line.Length > 0)
                    {
                        rules.Add(new ClineIgnoreRule
                        {
                            Pattern = line,
                            Negated = negated,
                            DirectoryOnly = directoryOnly,
                            Anchored = anchored
                        });
                    }
                }
            }
            catch
            {
            }

            return rules;
        }

        private static bool IsIgnoredByClineIgnore(string root, string path, List<ClineIgnoreRule> rules)
        {
            if (rules.Count == 0)
                return false;

            string relative;
            try
            {
                relative = GetRelativePath(root, path).Replace('\\', '/').TrimStart('/');
            }
            catch
            {
                return false;
            }

            if (relative.Length == 0 || relative.StartsWith("../", StringComparison.Ordinal) || relative == "..")
                return false;

            var isDirectory = Directory.Exists(path);
            var ignored = false;
            foreach (var rule in rules)
            {
                if (MatchesClineIgnoreRule(relative, isDirectory, rule))
                    ignored = !rule.Negated;
            }

            return ignored;
        }

        private static bool MatchesClineIgnoreRule(string relativePath, bool isDirectory, ClineIgnoreRule rule)
        {
            if (rule.DirectoryOnly && !isDirectory && relativePath.IndexOf("/", StringComparison.Ordinal) < 0)
                return false;

            var pattern = rule.Pattern;
            var hasSlash = pattern.IndexOf("/", StringComparison.Ordinal) >= 0;
            var hasWildcard = pattern.IndexOfAny(new[] { '*', '?' }) >= 0;

            if (!hasWildcard)
            {
                if (hasSlash || rule.Anchored)
                {
                    return string.Equals(relativePath, pattern, StringComparison.OrdinalIgnoreCase) ||
                           relativePath.StartsWith(pattern + "/", StringComparison.OrdinalIgnoreCase);
                }

                return relativePath.Split('/').Any(part => string.Equals(part, pattern, StringComparison.OrdinalIgnoreCase));
            }

			if (hasSlash || rule.Anchored)
				return WildcardMatch(relativePath, pattern) || WildcardMatch(relativePath, pattern + "/**");

            return relativePath.Split('/').Any(part => WildcardMatch(part, pattern));
        }

        private static bool WildcardMatch(string value, string pattern)
        {
            var regex = "^" + Regex.Escape(pattern)
                .Replace("\\*\\*", ".*")
                .Replace("\\*", "[^/]*")
                .Replace("\\?", "[^/]") + "$";

            return Regex.IsMatch(value, regex, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }

        private static string GetRelativePath(string root, string path)
        {
            var rootFullPath = EnsureTrailingDirectorySeparator(Path.GetFullPath(root));
            var pathFullPath = Path.GetFullPath(path);
            var rootUri = new Uri(rootFullPath);
            var pathUri = new Uri(pathFullPath);
            if (!string.Equals(rootUri.Scheme, pathUri.Scheme, StringComparison.OrdinalIgnoreCase))
                return pathFullPath;

            var relativeUri = rootUri.MakeRelativeUri(pathUri);
            return Uri.UnescapeDataString(relativeUri.ToString()).Replace('/', Path.DirectorySeparatorChar);
        }

        private static string EnsureTrailingDirectorySeparator(string path)
        {
            return path.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ||
                   path.EndsWith(Path.AltDirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? path
                : path + Path.DirectorySeparatorChar;
        }

        private static T InvokeOnUiThread<T>(Func<T> action)
        {
            var dispatcher = Application.Current?.Dispatcher;
            if (dispatcher == null || dispatcher.CheckAccess())
                return action();

            return VisualStudioUiThread.Invoke(action);
        }

        private static int? GetInt(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<int?>(name) : null;
        }

        private static bool GetBool(JToken? parameters, string name)
        {
            return parameters is JObject values && values.Value<bool?>(name) == true;
        }

        private static string GetString(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<string>(name) ?? "" : "";
        }
    }
}
