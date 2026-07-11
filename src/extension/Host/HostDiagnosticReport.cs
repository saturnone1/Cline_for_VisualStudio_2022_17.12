using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal sealed class HostDiagnosticContext
    {
        public string? AssemblyDirectory { get; set; }
        public bool WebviewReady { get; set; }
        public bool Loaded { get; set; }
        public bool SidecarRunning { get; set; }
        public string? LastSidecarError { get; set; }
        public string? LastWebMessageJson { get; set; }
    }

    internal static class HostDiagnosticReport
    {
        public static string Create(string summary, string? hint, JObject? webState, HostDiagnosticContext context)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var builder = new StringBuilder();
            builder.AppendLine(summary);
            builder.AppendLine();
            builder.AppendLine("=== Snapshot ===");
            builder.AppendLine("Time: " + DateTime.Now.ToString("O"));
            builder.AppendLine("VsClineAgent assembly: " + GetDisplayAssemblyVersion(assembly));
            builder.AppendLine("Assembly location: " + assembly.Location);
            builder.AppendLine("Assembly directory: " + (context.AssemblyDirectory ?? "(unset)"));
            builder.AppendLine("WebView ready: " + context.WebviewReady);
            builder.AppendLine("Loaded: " + context.Loaded);
            builder.AppendLine("Sidecar running: " + context.SidecarRunning);
            builder.AppendLine("Last sidecar error: " + (context.LastSidecarError ?? "(none)"));
            builder.AppendLine();

            if (webState != null)
            {
                builder.AppendLine("=== WebView State ===");
                builder.AppendLine(webState.ToString(Formatting.Indented));
                builder.AppendLine();
            }

            builder.AppendLine("=== Last Web Message From WebApp ===");
            builder.AppendLine(PrettyJsonOrRaw(context.LastWebMessageJson));
            builder.AppendLine();
            builder.AppendLine("=== Sidecar Log Tail ===");
            builder.AppendLine(ReadSidecarLogTail());
            builder.AppendLine();
            builder.AppendLine("=== Node Processes ===");
            builder.AppendLine(ReadNodeProcesses());
            builder.AppendLine();
            builder.AppendLine("=== Local Runtime Files ===");
            builder.AppendLine(ReadRuntimeSummary());
            builder.AppendLine();

            if (!string.IsNullOrWhiteSpace(hint))
            {
                builder.AppendLine("=== Hint ===");
                builder.AppendLine(hint);
                builder.AppendLine();
            }

            builder.AppendLine("You can select this text with Ctrl+A and copy it with Ctrl+C.");
            return builder.ToString();
        }

        public static void WriteSnapshot(string message)
        {
            try
            {
                var directory = Path.Combine(LocalRoot(), "logs");
                Directory.CreateDirectory(directory);
                File.WriteAllText(
                    Path.Combine(directory, "diagnostic-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log"),
                    message,
                    Encoding.UTF8);
            }
            catch { }
        }

        private static string GetDisplayAssemblyVersion(Assembly assembly)
        {
            var informationalVersion = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            return !string.IsNullOrWhiteSpace(informationalVersion)
                ? informationalVersion!
                : assembly.GetName().Version?.ToString() ?? "unknown";
        }

        private static string PrettyJsonOrRaw(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return "(none)";
            try { return JToken.Parse(value!).ToString(Formatting.Indented); }
            catch { return value!; }
        }

        private static string ReadSidecarLogTail()
        {
            try
            {
                var path = Path.Combine(LocalRoot(), "logs", "sidecar-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
                if (!File.Exists(path))
                    return "No sidecar log found at " + path;
                var lines = File.ReadAllLines(path);
                return "Path: " + path + Environment.NewLine +
                       string.Join(Environment.NewLine, lines.Skip(Math.Max(0, lines.Length - 200)));
            }
            catch (Exception ex) { return "Failed to read sidecar log: " + ex; }
        }

        private static string ReadNodeProcesses()
        {
            try
            {
                var builder = new StringBuilder();
                foreach (var process in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        builder.AppendLine("PID: " + process.Id);
                        builder.AppendLine("Path: " + SafeRead(() => process.MainModule?.FileName ?? "(unknown)"));
                        builder.AppendLine("Started: " + SafeRead(() => process.StartTime.ToString("O")));
                        builder.AppendLine();
                    }
                    catch (Exception ex) { builder.AppendLine("PID: " + process.Id + " (" + ex.Message + ")"); }
                }
                return builder.Length == 0 ? "(none)" : builder.ToString();
            }
            catch (Exception ex) { return "Failed to enumerate node processes: " + ex; }
        }

        private static string ReadRuntimeSummary()
        {
            try
            {
                var roots = new[] { Path.Combine(LocalRoot(), "Sidecar", "1.0.0"), Path.Combine(LocalRoot(), "logs") };
                var builder = new StringBuilder();
                foreach (var root in roots)
                {
                    builder.AppendLine(root);
                    if (!Directory.Exists(root))
                    {
                        builder.AppendLine("  (missing)");
                        continue;
                    }
                    foreach (var entry in Directory.EnumerateFileSystemEntries(root).Take(80))
                    {
                        var info = new FileInfo(entry);
                        builder.AppendLine("  " + Path.GetFileName(entry) + " | " +
                            (Directory.Exists(entry) ? "dir" : info.Length.ToString()) + " | " + info.LastWriteTime.ToString("O"));
                    }
                }
                return builder.ToString();
            }
            catch (Exception ex) { return "Failed to read runtime summary: " + ex; }
        }

        private static string SafeRead(Func<string> read)
        {
            try { return read(); }
            catch (Exception ex) { return "(" + ex.Message + ")"; }
        }

        private static string LocalRoot()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VsClineAgent");
        }
    }
}
