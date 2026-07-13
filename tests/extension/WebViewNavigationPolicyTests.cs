using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebViewNavigationPolicyTests
    {
        [Theory]
        [InlineData("https://example.com/path")]
        [InlineData("http://localhost:3000")]
        [InlineData("mailto:test@example.com")]
        public void SupportedExternalUrisOpenOutsideTheWebView(string uri)
        {
            Assert.True(WebViewNavigationPolicy.ShouldOpenExternally(uri));
        }

        [Theory]
        [InlineData("https://vscline.local/index.html")]
        [InlineData("file:///C:/temp/file.txt")]
        [InlineData("javascript:alert(1)")]
        [InlineData("not a uri")]
        [InlineData(null)]
        public void InternalOrUnsupportedUrisStayInTheWebView(string? uri)
        {
            Assert.False(WebViewNavigationPolicy.ShouldOpenExternally(uri));
        }
    }
}
