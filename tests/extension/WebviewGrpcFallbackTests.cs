using Newtonsoft.Json.Linq;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebviewGrpcFallbackTests
    {
        [Fact]
        public void PassiveStreamingSubscriptionRequiresKnownStreamingMethod()
        {
            Assert.True(WebviewGrpcFallback.IsPassiveStreamingSubscription(Request("UiService", "subscribeToPartialMessage", "stream-1", true)));
            Assert.False(WebviewGrpcFallback.IsPassiveStreamingSubscription(Request("UiService", "subscribeToPartialMessage", "unary-1", false)));
            Assert.False(WebviewGrpcFallback.IsPassiveStreamingSubscription(Request("UiService", "unknown", "stream-2", true)));
        }

        [Fact]
        public void IncompatibleProtocolIsRejected()
        {
            var envelope = JObject.Parse(Request("StateService", "subscribeToState", "state-1", true));
            envelope["protocol_version"] = 2;

            Assert.False(WebviewGrpcFallback.IsPassiveStreamingSubscription(envelope.ToString()));
            var response = WebviewGrpcFallback.CreateErrorResponse(envelope.ToString(), "not running");
            Assert.Equal(1, response.Value<int>("protocol_version"));
            Assert.Equal("error", response.Value<string>("type"));
        }

        [Fact]
        public void ErrorResponsePreservesCorrelationAndProtocol()
        {
            var response = WebviewGrpcFallback.CreateErrorResponse(Request("TaskService", "newTask", "task-1", false), "sidecar unavailable");

            Assert.Equal(1, response.Value<int>("protocol_version"));
            Assert.Equal("grpc_response", response.Value<string>("type"));
            Assert.Equal("task-1", response["grpc_response"]?.Value<string>("request_id"));
            Assert.Equal("sidecar unavailable", response["grpc_response"]?.Value<string>("error"));
            Assert.False(response["grpc_response"]?.Value<bool>("is_streaming"));
        }

        [Fact]
        public void MalformedRequestProducesVersionedGenericError()
        {
            var response = WebviewGrpcFallback.CreateErrorResponse("{", "invalid request");

            Assert.Equal(1, response.Value<int>("protocol_version"));
            Assert.Equal("error", response.Value<string>("type"));
            Assert.Equal("invalid request", response.Value<string>("message"));
        }

        private static string Request(string service, string method, string requestId, bool streaming)
        {
            return new JObject
            {
                ["protocol_version"] = 1,
                ["type"] = "grpc_request",
                ["grpc_request"] = new JObject
                {
                    ["service"] = service,
                    ["method"] = method,
                    ["request_id"] = requestId,
                    ["is_streaming"] = streaming,
                    ["message"] = new JObject()
                }
            }.ToString();
        }
    }
}
