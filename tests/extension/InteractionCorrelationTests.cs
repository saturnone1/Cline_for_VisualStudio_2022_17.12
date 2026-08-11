using Newtonsoft.Json.Linq;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class InteractionCorrelationTests
    {
        [Theory]
        [InlineData("{\"correlationId\":\"explicit\",\"requestId\":\"request\"}", "explicit")]
        [InlineData("{\"grpc_request\":{\"request_id\":\"webview-1\",\"message\":{\"sessionId\":\"session-1\"}}}", "webview-1")]
        [InlineData("{\"result\":{\"grpc_response\":{\"request_id\":\"response-1\"}}}", "response-1")]
        public void ExtractsStableIdentifierFromNestedWirePayload(string json, string expected)
        {
            Assert.Equal(expected, InteractionCorrelation.FromPayload(JObject.Parse(json)));
        }

        [Fact]
        public void ReturnsNullForUncorrelatedOrMalformedPayload()
        {
            Assert.Null(InteractionCorrelation.FromPayload(new { unrelated = true }));
            Assert.Null(InteractionCorrelation.FromPayload("{"));
        }
    }
}
