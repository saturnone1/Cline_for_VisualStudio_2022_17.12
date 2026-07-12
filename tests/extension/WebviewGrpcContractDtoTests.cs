using Newtonsoft.Json;
using VsClineAgent.Host.Generated;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebviewGrpcContractDtoTests
    {
        [Theory]
        [InlineData("{\"protocol_version\":1,\"type\":\"grpc_request\",\"grpc_request\":{\"service\":\"StateService\",\"method\":\"subscribeToState\",\"request_id\":\"snake\",\"is_streaming\":true}}", "snake")]
        [InlineData("{\"protocolVersion\":1,\"type\":\"grpc_request\",\"grpc_request\":{\"service\":\"StateService\",\"method\":\"subscribeToState\",\"requestId\":\"camel\",\"isStreaming\":true}}", "camel")]
        public void GeneratedEnvelopeAcceptsSupportedWireNaming(string json, string requestId)
        {
            var envelope = JsonConvert.DeserializeObject<WebviewGrpcEnvelope>(json);

            Assert.NotNull(envelope);
            Assert.Equal(WebviewRpcContract.ProtocolVersion, envelope!.ProtocolVersion);
            Assert.Equal("grpc_request", envelope.Type);
            Assert.NotNull(envelope.Request);
            Assert.Equal(requestId, envelope.Request.RequestId);
            Assert.True(envelope.Request.IsStreaming);
        }
    }
}
