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
        private const int MaxStringChars = 4096;
        private const int MaxArrayItems = 50;
        private const int MaxObjectProperties = 80;
        private const int MaxDepth = 8;
        private static readonly object Gate = new object();

        public static void Write(string direction, string eventName, object? payload)
        {
            try
            {
                if (ShouldSkipDefaultLog(eventName, payload))
                    return;

                var entry = new JObject
                {
                    ["at"] = DateTimeOffset.Now.ToString("O"),
                    ["source"] = "vsix-host",
                    ["direction"] = direction,
                    ["event"] = eventName,
                    ["payload"] = Sanitize(CompactPayload(eventName, payload))
                };

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

        private static JToken Sanitize(object? payload)
        {
            if (payload == null)
                return JValue.CreateNull();

            JToken token;
            if (payload is JToken existing)
            {
                token = existing.DeepClone();
            }
            else if (payload is string text)
            {
                token = TryParseJson(text) ?? new JValue(text);
            }
            else
            {
                token = JToken.FromObject(payload);
            }

            Redact(token, 0);
            return token;
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

        private static void Redact(JToken token, int depth)
        {
            if (depth >= MaxDepth)
            {
                ReplaceToken(token, new JValue("[max-depth]"));
                return;
            }

            if (token is JObject obj)
            {
                var properties = obj.Properties().ToList();
                foreach (var property in properties.Take(MaxObjectProperties))
                {
                    if (IsSensitiveKey(property.Name))
                    {
                        property.Value = RedactedValue(property.Value);
                    }
                    else
                    {
                        Redact(property.Value, depth + 1);
                    }
                }

                foreach (var property in properties.Skip(MaxObjectProperties).ToList())
                    property.Remove();

                if (properties.Count > MaxObjectProperties)
                    obj["__truncatedProperties"] = properties.Count - MaxObjectProperties;
            }
            else if (token is JArray array)
            {
                var items = array.ToList();
                foreach (var item in items.Take(MaxArrayItems))
                    Redact(item, depth + 1);

                while (array.Count > MaxArrayItems)
                    array.RemoveAt(array.Count - 1);

                if (items.Count > MaxArrayItems)
                    array.Add("[truncated " + (items.Count - MaxArrayItems) + " items]");
            }
            else if (token is JValue value && value.Type == JTokenType.String)
            {
                var text = value.ToString();
                var parsed = TryParseJson(text);
                if (parsed != null)
                {
                    Redact(parsed, depth + 1);
                    value.Value = TruncateDiagnosticString(parsed.ToString(Formatting.None));
                }
                else
                {
                    value.Value = TruncateDiagnosticString(RedactSecretLikeString(text));
                }
            }
        }

        private static void ReplaceToken(JToken token, JToken replacement)
        {
            if (token.Parent != null)
                token.Replace(replacement);
        }

        private static bool IsSensitiveKey(string key)
        {
            return key.IndexOf("apiKey", StringComparison.OrdinalIgnoreCase) >= 0
                || key.IndexOf("api_key", StringComparison.OrdinalIgnoreCase) >= 0
                || key.IndexOf("authorization", StringComparison.OrdinalIgnoreCase) >= 0
                || key.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0
                || key.IndexOf("token", StringComparison.OrdinalIgnoreCase) >= 0
                || key.Equals("key", StringComparison.OrdinalIgnoreCase);
        }

        private static JValue RedactedValue(JToken value)
        {
            var text = value.Type == JTokenType.String ? value.ToString() : "";
            if (text.Length <= 8)
                return new JValue("[redacted]");

            return new JValue(text.Substring(0, 4) + "..." + text.Substring(text.Length - 4));
        }

        private static string RedactSecretLikeString(string value)
        {
            if (string.IsNullOrEmpty(value))
                return value;

            return System.Text.RegularExpressions.Regex.Replace(
                value,
                @"\b(sk-[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|nvapi-[A-Za-z0-9_-]{12,})\b",
                match => match.Value.Substring(0, Math.Min(7, match.Value.Length)) + "..." + match.Value.Substring(Math.Max(0, match.Value.Length - 4)));
        }

        private static string TruncateDiagnosticString(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= MaxStringChars)
                return value;

            return value.Substring(0, MaxStringChars) + "...[truncated " + (value.Length - MaxStringChars) + " chars]";
        }

        private static string GetLogPath()
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "logs");
            Directory.CreateDirectory(directory);
            return Path.Combine(directory, "interaction-" + DateTime.Now.ToString("yyyyMMdd") + ".jsonl");
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
