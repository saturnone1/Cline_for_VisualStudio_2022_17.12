using System;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal static class InteractionLog
    {
        private const long MaxBytes = 8L * 1024L * 1024L;
        private const int MaxLineChars = 96 * 1024;
        private static readonly object Gate = new object();

        public static void Write(string direction, string eventName, object? payload)
        {
            try
            {
                var entry = new JObject
                {
                    ["at"] = DateTimeOffset.Now.ToString("O"),
                    ["source"] = "vsix-host",
                    ["direction"] = direction,
                    ["event"] = eventName,
                    ["payload"] = Sanitize(payload)
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

            Redact(token);
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

        private static void Redact(JToken token)
        {
            if (token is JObject obj)
            {
                foreach (var property in obj.Properties())
                {
                    if (IsSensitiveKey(property.Name))
                    {
                        property.Value = RedactedValue(property.Value);
                    }
                    else
                    {
                        Redact(property.Value);
                    }
                }
            }
            else if (token is JArray array)
            {
                foreach (var item in array)
                    Redact(item);
            }
            else if (token is JValue value && value.Type == JTokenType.String)
            {
                var text = value.ToString();
                var parsed = TryParseJson(text);
                if (parsed != null)
                {
                    Redact(parsed);
                    value.Value = parsed.ToString(Formatting.None);
                }
                else
                {
                    value.Value = RedactSecretLikeString(text);
                }
            }
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
