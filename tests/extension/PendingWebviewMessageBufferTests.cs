using System.Linq;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class PendingWebviewMessageBufferTests
    {
        [Fact]
        public void FailedDeliveriesReturnToThePendingBuffer()
        {
            var buffer = new PendingWebviewMessageBuffer();
            buffer.Enqueue("first");
            buffer.Enqueue("second");

            var delivery = buffer.TakeAll();
            buffer.ReturnFailed(new[] { delivery[1] });

            Assert.Equal(new[] { "second" }, buffer.TakeAll());
        }

        [Fact]
        public void OverflowKeepsLatestStatePerRequest()
        {
            var buffer = new PendingWebviewMessageBuffer(3);
            var oldState = State("state-1", "old");
            var newState = State("state-1", "new");
            buffer.Enqueue(oldState);
            buffer.Enqueue("ordinary-1");
            buffer.Enqueue(newState);
            buffer.Enqueue("ordinary-2");

            var pending = buffer.TakeAll();

            Assert.Equal(3, pending.Length);
            Assert.DoesNotContain(oldState, pending);
            Assert.Contains(newState, pending);
            Assert.Equal(new[] { "ordinary-1", "ordinary-2" }, pending.Where(item => item.StartsWith("ordinary-")));
        }

        [Fact]
        public void ClearDropsAllPendingMessages()
        {
            var buffer = new PendingWebviewMessageBuffer();
            buffer.Enqueue("message");
            buffer.Clear();

            Assert.Equal(0, buffer.Count);
            Assert.Empty(buffer.TakeAll());
        }

        private static string State(string requestId, string stateJson)
        {
            return new JObject
            {
                ["grpc_response"] = new JObject
                {
                    ["request_id"] = requestId,
                    ["message"] = new JObject { ["stateJson"] = stateJson }
                }
            }.ToString();
        }
    }
}
