using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal static class InteractionLogSanitizer
    {
        private const int MaxStringChars = 4096;
        private const int MaxArrayItems = 50;
        private const int MaxObjectProperties = 80;
        private const int MaxDepth = 8;

        public static JToken Sanitize(object? payload)
        {
            if (payload == null)
                return JValue.CreateNull();

            JToken token;
            if (payload is JToken existing)
                token = existing.DeepClone();
            else if (payload is string text)
                token = TryParseJson(text) ?? new JValue(text);
            else
                token = JToken.FromObject(payload);

            Redact(token, 0);
            return token;
        }

        private static JToken? TryParseJson(string text)
        {
            try { return JToken.Parse(text); }
            catch { return null; }
        }

        private static void Redact(JToken token, int depth)
        {
            if (depth >= MaxDepth) { ReplaceToken(token, new JValue("[max-depth]")); return; }

            if (token is JObject obj)
            {
                var properties = obj.Properties().ToList();
                foreach (var property in properties.Take(MaxObjectProperties))
                {
                    if (IsSensitiveKey(property.Name)) property.Value = RedactedValue(property.Value);
                    else Redact(property.Value, depth + 1);
                }
                foreach (var property in properties.Skip(MaxObjectProperties).ToList()) property.Remove();
                if (properties.Count > MaxObjectProperties) obj["__truncatedProperties"] = properties.Count - MaxObjectProperties;
                return;
            }

            if (token is JArray array)
            {
                var items = array.ToList();
                foreach (var item in items.Take(MaxArrayItems)) Redact(item, depth + 1);
                while (array.Count > MaxArrayItems) array.RemoveAt(array.Count - 1);
                if (items.Count > MaxArrayItems) array.Add("[truncated " + (items.Count - MaxArrayItems) + " items]");
                return;
            }

            if (token is JValue value && value.Type == JTokenType.String)
            {
                var text = value.ToString();
                var parsed = TryParseJson(text);
                if (parsed != null) { Redact(parsed, depth + 1); value.Value = Truncate(parsed.ToString(Formatting.None)); }
                else value.Value = Truncate(RedactSecretLikeString(text));
            }
        }

        private static void ReplaceToken(JToken token, JToken replacement) { if (token.Parent != null) token.Replace(replacement); }

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
            return new JValue(text.Length <= 8 ? "[redacted]" : text.Substring(0, 4) + "..." + text.Substring(text.Length - 4));
        }

        private static string RedactSecretLikeString(string value)
        {
            if (string.IsNullOrEmpty(value)) return value;
            return System.Text.RegularExpressions.Regex.Replace(
                value,
                @"\b(sk-[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|nvapi-[A-Za-z0-9_-]{12,})\b",
                match => match.Value.Substring(0, Math.Min(7, match.Value.Length)) + "..." + match.Value.Substring(Math.Max(0, match.Value.Length - 4)));
        }

        private static string Truncate(string value)
        {
            return string.IsNullOrEmpty(value) || value.Length <= MaxStringChars
                ? value
                : value.Substring(0, MaxStringChars) + "...[truncated " + (value.Length - MaxStringChars) + " chars]";
        }
    }
}
