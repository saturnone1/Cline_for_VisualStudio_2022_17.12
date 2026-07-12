using System;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal static class WebviewGrpcFallback
    {
        private const int ProtocolVersion = 1;

        public static bool IsPassiveStreamingSubscription(string rawJson)
        {
            try
            {
                var request = GetGrpcRequest(rawJson);
                if (request == null || !IsStreaming(request))
                    return false;

                var key = (request.Value<string>("service") ?? "") + "." +
                          (request.Value<string>("method") ?? "");
                switch (key)
                {
                    case "UiService.subscribeToMcpButtonClicked":
                    case "UiService.subscribeToHistoryButtonClicked":
                    case "UiService.subscribeToChatButtonClicked":
                    case "UiService.subscribeToSettingsButtonClicked":
                    case "UiService.subscribeToWorktreesButtonClicked":
                    case "UiService.subscribeToAccountButtonClicked":
                    case "UiService.subscribeToRelinquishControl":
                    case "UiService.subscribeToShowWebview":
                    case "UiService.subscribeToAddToInput":
                    case "UiService.subscribeToPartialMessage":
                    case "McpService.subscribeToMcpMarketplaceCatalog":
                    case "McpService.subscribeToMcpServers":
                    case "ModelsService.subscribeToOpenRouterModels":
                    case "ModelsService.subscribeToLiteLlmModels":
                        return true;
                    default:
                        return false;
                }
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
                    ["protocol_version"] = ProtocolVersion,
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
            if (protocolVersion.HasValue && protocolVersion.Value != ProtocolVersion)
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
                ["protocol_version"] = ProtocolVersion,
                ["type"] = "error",
                ["message"] = message
            };
        }
    }
}
