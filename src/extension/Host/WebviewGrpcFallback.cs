using System;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Generated;

namespace VsClineAgent.Host
{
    internal static class WebviewGrpcFallback
    {
        public static bool IsPassiveStreamingSubscription(string rawJson)
        {
            try
            {
                var request = GetGrpcRequest(rawJson);
                if (request == null || !IsStreaming(request))
                    return false;

                return WebviewRpcContract.IsPassiveFallback(
                    request.Value<string>("service") ?? "",
                    request.Value<string>("method") ?? "");
            }
            catch
            {
                return false;
            }
        }

        public static JObject CreateErrorResponse(string rawJson, string message)
        {
            try
            {
                var request = GetGrpcRequest(rawJson);
                var requestId = request?.Value<string>("request_id") ?? request?.Value<string>("requestId");
                if (request == null || string.IsNullOrWhiteSpace(requestId))
                    return CreateGenericError(message);

                return new JObject
                {
                    ["protocol_version"] = WebviewRpcContract.ProtocolVersion,
                    ["type"] = "grpc_response",
                    ["grpc_response"] = new JObject
                    {
                        ["request_id"] = requestId,
                        ["error"] = message,
                        ["is_streaming"] = IsStreaming(request)
                    }
                };
            }
            catch
            {
                return CreateGenericError(message);
            }
        }

        private static JObject? GetGrpcRequest(string rawJson)
        {
            var envelope = JObject.Parse(rawJson);
            var protocolVersion = envelope.Value<int?>("protocol_version") ??
                                  envelope.Value<int?>("protocolVersion");
            if (protocolVersion.HasValue && protocolVersion.Value != WebviewRpcContract.ProtocolVersion)
                return null;
            return string.Equals(envelope.Value<string>("type"), "grpc_request", StringComparison.Ordinal)
                ? envelope["grpc_request"] as JObject
                : null;
        }

        private static bool IsStreaming(JObject request)
        {
            return request.Value<bool?>("is_streaming") == true ||
                   request.Value<bool?>("isStreaming") == true;
        }

        private static JObject CreateGenericError(string message)
        {
            return new JObject
            {
                ["protocol_version"] = WebviewRpcContract.ProtocolVersion,
                ["type"] = "error",
                ["message"] = message
            };
        }
    }
}
