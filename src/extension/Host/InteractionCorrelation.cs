using System;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal static class InteractionCorrelation
    {
        private static readonly string[] IdentifierKeys =
        {
            "correlationId", "correlation_id", "requestId", "request_id", "sessionId", "session_id", "id"
        };

        private static readonly string[] ContainerKeys =
        {
            "request", "grpc_request", "grpc_response", "payload", "params", "result", "event", "message"
        };

        public static string? FromPayload(object? payload)
        {
            try
            {
                var token = payload as JToken ?? (payload is string text ? TryParse(text) : payload == null ? null : JToken.FromObject(payload));
                return Find(token, 0);
            }
            catch
            {
                return null;
            }
        }

        private static string? Find(JToken? token, int depth)
        {
            if (token == null || depth > 6) return null;
            if (token is JArray array)
            {
                foreach (var item in array)
                {
                    var found = Find(item, depth + 1);
                    if (!string.IsNullOrWhiteSpace(found)) return found;
                }
                return null;
            }
            if (!(token is JObject obj)) return null;
            foreach (var key in IdentifierKeys)
            {
                var value = obj[key];
                if (value != null && value.Type != JTokenType.Null && !string.IsNullOrWhiteSpace(value.ToString())) return value.ToString();
            }
            foreach (var key in ContainerKeys)
            {
                var found = Find(obj[key], depth + 1);
                if (!string.IsNullOrWhiteSpace(found)) return found;
            }
            return null;
        }

        private static JToken? TryParse(string text)
        {
            try { return JToken.Parse(text); }
            catch { return null; }
        }
    }
}
