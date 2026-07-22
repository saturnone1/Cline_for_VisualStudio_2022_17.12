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

		[Fact]
		public void OverflowPreservesNonReplaceableResponsesBeyondTheSoftLimit()
		{
			var buffer = new PendingWebviewMessageBuffer(2, 3);
			buffer.Enqueue("unary-response-1");
			buffer.Enqueue("completion-event");
			buffer.Enqueue("unary-response-2");

			Assert.Equal(new[] { "unary-response-1", "completion-event", "unary-response-2" }, buffer.TakeAll());
			Assert.Equal(0, buffer.TakeDroppedCount());
		}

		[Fact]
		public void HardLimitBoundsNonReplaceableResponses()
		{
			var buffer = new PendingWebviewMessageBuffer(2, 3);
			buffer.Enqueue("response-1");
			buffer.Enqueue("response-2");
			buffer.Enqueue("response-3");
			buffer.Enqueue("response-4");

			Assert.Equal(new[] { "response-2", "response-3", "response-4" }, buffer.TakeAll());
			Assert.Equal(1, buffer.TakeDroppedCount());
		}

		[Fact]
		public void OverflowKeepsLatestPartialPerStreamMessage()
		{
			var buffer = new PendingWebviewMessageBuffer(2);
			var oldPartial = Partial("partial-1", 42, "hel");
			var newPartial = Partial("partial-1", 42, "hello");
			buffer.Enqueue(oldPartial);
			buffer.Enqueue("ordinary");
			buffer.Enqueue(newPartial);

			var pending = buffer.TakeAll();
			Assert.Equal(2, pending.Length);
			Assert.DoesNotContain(oldPartial, pending);
			Assert.Contains(newPartial, pending);
			Assert.Contains("ordinary", pending);
		}

        private static string State(string requestId, string stateJson)
        {
            return new JObject
            {
                ["grpc_response"] = new JObject
                {
                    ["request_id"] = requestId,
					["message"] = new JObject { ["stateJson"] = stateJson },
					["is_streaming"] = true
                }
            }.ToString();
        }

		private static string Partial(string requestId, long timestamp, string text)
		{
			return new JObject
			{
				["grpc_response"] = new JObject
				{
					["request_id"] = requestId,
					["is_streaming"] = true,
					["message"] = new JObject { ["ts"] = timestamp, ["partial"] = true, ["text"] = text }
				}
			}.ToString();
		}
    }
}
