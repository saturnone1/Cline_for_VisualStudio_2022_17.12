using System;
using Newtonsoft.Json;
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
                if (request == null || !request.IsStreaming)
                    return false;

                return WebviewRpcContract.IsPassiveFallback(
                    request.Service,
                    request.Method);
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
                var requestId = request?.RequestId;
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
                        ["is_streaming"] = request.IsStreaming
                    }
                };
            }
            catch
            {
                return CreateGenericError(message);
            }
        }

        private static WebviewGrpcRequest? GetGrpcRequest(string rawJson)
        {
            var envelope = JsonConvert.DeserializeObject<WebviewGrpcEnvelope>(rawJson);
            if (envelope == null ||
                (envelope.ProtocolVersion.HasValue && envelope.ProtocolVersion.Value != WebviewRpcContract.ProtocolVersion))
                return null;
            return string.Equals(envelope.Type, "grpc_request", StringComparison.Ordinal)
                ? envelope.Request
                : null;
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
