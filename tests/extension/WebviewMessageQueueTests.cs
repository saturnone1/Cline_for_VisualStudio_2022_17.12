using System;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebviewMessageQueueTests
    {
        [Fact]
        public async Task FailedUiDispatchIsRetriedInsteadOfLeavingQueueScheduled()
        {
            var attempts = 0;
            using (var queue = new WebviewMessageQueue(
                () => null,
                action =>
                {
                    if (Interlocked.Increment(ref attempts) == 1)
                        return Task.FromException(new InvalidOperationException("UI dispatcher unavailable"));
                    action();
                    return Task.CompletedTask;
                }))
            {
                queue.SetReady(true);
                queue.Enqueue("{\"type\":\"state\"}");

                var deadline = DateTime.UtcNow.AddSeconds(2);
                while (Volatile.Read(ref attempts) < 2 && DateTime.UtcNow < deadline)
                    await Task.Delay(25);

                Assert.True(attempts >= 2);
            }
        }
    }
}
