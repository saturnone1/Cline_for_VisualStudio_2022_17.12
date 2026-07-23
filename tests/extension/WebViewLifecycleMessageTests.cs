using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebViewLifecycleMessageTests
    {
        [Fact]
        public void AcceptsOnlyTheVersionedHydrationSignal()
        {
            Assert.True(WebViewLifecycleMessage.IsHydrated(@"{""protocol_version"":1,""type"":""vscline.webview.hydrated""}"));
            Assert.False(WebViewLifecycleMessage.IsHydrated(@"{""type"":""vscline.webview.hydrated""}"));
            Assert.False(WebViewLifecycleMessage.IsHydrated(@"{""protocol_version"":2,""type"":""vscline.webview.hydrated""}"));
            Assert.False(WebViewLifecycleMessage.IsHydrated("not-json"));
        }
    }
}
