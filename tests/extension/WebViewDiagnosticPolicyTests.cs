using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebViewDiagnosticPolicyTests
    {
        [Fact]
        public void HydratedRuntimeDiagnosticsDoNotReplaceTheConversation()
        {
            Assert.False(WebViewDiagnosticPolicy.ShouldReplaceContent(true, true, "unhandledrejection"));
        }

        [Theory]
        [InlineData(false, false)]
        [InlineData(true, false)]
        public void StartupDiagnosticsRemainBlocking(bool initialized, bool hydrated)
        {
            Assert.True(WebViewDiagnosticPolicy.ShouldReplaceContent(initialized, hydrated, "error"));
        }

        [Fact]
        public void ExplicitFatalDiagnosticsRemainBlockingAfterHydration()
        {
            Assert.True(WebViewDiagnosticPolicy.ShouldReplaceContent(true, true, "fatal"));
        }
    }
}
