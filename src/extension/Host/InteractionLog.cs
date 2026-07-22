using System;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal static class InteractionLog
    {
        private const long MaxBytes = 8L * 1024L * 1024L;
        private const int MaxLineChars = 96 * 1024;
        private const long MaxTotalBytes = 150L * 1024L * 1024L;
        private static readonly object Gate = new object();
        private static string _lastCleanupDate = "";

        public static void Write(string direction, string eventName, object? payload)
        {
            try
            {
                if (ShouldSkipDefaultLog(eventName, payload))
                    return;

                var compactPayload = CompactPayload(eventName, payload);
                var entry = new JObject
                {
                    ["at"] = DateTimeOffset.Now.ToString("O"),
                    ["source"] = "vsix-host",
                    ["direction"] = direction,
                    ["event"] = eventName,
                    ["payload"] = InteractionLogSanitizer.Sanitize(compactPayload)
                };
                var correlationId = InteractionCorrelation.FromPayload(compactPayload);
                if (!string.IsNullOrWhiteSpace(correlationId))
                    entry["correlationId"] = correlationId;

                var line = entry.ToString(Formatting.None);
                if (line.Length > MaxLineChars)
                    line = line.Substring(0, MaxLineChars) + "...[truncated]";

                lock (Gate)
                {
                    var path = GetLogPath();
                    RotateIfNeeded(path);
                    File.AppendAllText(path, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch
            {
            }
        }

        private static bool ShouldSkipDefaultLog(string eventName, object? payload)
        {
            if (string.Equals(Environment.GetEnvironmentVariable("VSCLINE_VERBOSE_INTERACTION_LOG"), "1", StringComparison.Ordinal))
                return false;

            if (!string.Equals(Environment.GetEnvironmentVariable("VSCLINE_ENABLE_INTERACTION_LOG"), "1", StringComparison.Ordinal)
                && eventName.IndexOf("failed", StringComparison.OrdinalIgnoreCase) < 0
                && eventName.IndexOf("error", StringComparison.OrdinalIgnoreCase) < 0
                && eventName.IndexOf("slow", StringComparison.OrdinalIgnoreCase) < 0)
                return true;

            if (eventName == "webview.postMessage" || eventName == "webview.message.batchItem")
                return true;

            if (eventName == "webview.message.result")
            {
                var token = payload as JToken;
                var webviewMessages = token?["webviewMessages"] as JArray;
                return webviewMessages != null && webviewMessages.Count > 0;
            }

            return false;
        }

        private static object? CompactPayload(string eventName, object? payload)
        {
            if (eventName == "webview.message" && payload is string rawJson)
                return SummarizeWebviewMessage(rawJson);

            return payload;
        }

        private static JObject SummarizeWebviewMessage(string rawJson)
        {
            var parsed = TryParseJson(rawJson) as JObject;
            var request = parsed?["grpc_request"] as JObject;
            var cancel = parsed?["grpc_request_cancel"] as JObject;
            return new JObject
            {
                ["type"] = parsed?["type"]?.ToString(),
                ["service"] = request?["service"]?.ToString(),
                ["method"] = request?["method"]?.ToString(),
                ["requestId"] = request?["request_id"]?.ToString() ?? request?["requestId"]?.ToString() ?? cancel?["request_id"]?.ToString(),
                ["isStreaming"] = request?["is_streaming"]?.Value<bool?>() ?? request?["isStreaming"]?.Value<bool?>() ?? false,
                ["rawLength"] = rawJson.Length
            };
        }

        private static JToken? TryParseJson(string text)
        {
            try
            {
                return JToken.Parse(text);
            }
            catch
            {
                return null;
            }
        }

        private static string GetLogPath()
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "logs");
            Directory.CreateDirectory(directory);
            CleanupLogsOncePerDay(directory);
            return Path.Combine(directory, "interaction-" + DateTime.Now.ToString("yyyyMMdd") + ".jsonl");
        }

        private static void CleanupLogsOncePerDay(string directory)
        {
            var date = DateTime.Now.ToString("yyyyMMdd");
            if (string.Equals(_lastCleanupDate, date, StringComparison.Ordinal))
                return;
            _lastCleanupDate = date;
            var retentionDays = string.Equals(Environment.GetEnvironmentVariable("VSCLINE_VERBOSE_INTERACTION_LOG"), "1", StringComparison.Ordinal) ? 7 : 14;
            var currentPath = Path.GetFullPath(Path.Combine(directory, "interaction-" + date + ".jsonl"));
            try
            {
                var cutoff = DateTime.UtcNow.AddDays(-retentionDays);
                var files = new DirectoryInfo(directory).EnumerateFiles("interaction-*.jsonl*")
                    .OrderBy(file => file.LastWriteTimeUtc).ToList();
                foreach (var file in files.Where(file => !string.Equals(file.FullName, currentPath, StringComparison.OrdinalIgnoreCase) && file.LastWriteTimeUtc < cutoff).ToList())
                    TryDelete(file);
                files = files.Where(file => file.Exists).OrderBy(file => file.LastWriteTimeUtc).ToList();
                var total = files.Sum(file => file.Length);
                foreach (var file in files)
                {
                    if (total <= MaxTotalBytes)
                        break;
                    if (string.Equals(file.FullName, currentPath, StringComparison.OrdinalIgnoreCase))
                        continue;
                    var length = file.Length;
                    if (TryDelete(file))
                        total -= length;
                }
            }
            catch
            {
            }
        }

        private static bool TryDelete(FileInfo file)
        {
            try { file.Delete(); return true; }
            catch { return false; }
        }

        private static void RotateIfNeeded(string path)
        {
            if (!File.Exists(path))
                return;

            var info = new FileInfo(path);
            if (info.Length < MaxBytes)
                return;

            var archive = path + ".1";
            if (File.Exists(archive))
                File.Delete(archive);
            File.Move(path, archive);
        }
    }
}
