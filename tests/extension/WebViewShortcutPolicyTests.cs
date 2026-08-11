using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebViewShortcutPolicyTests
    {
        [Theory]
        [InlineData(false, false, "Debug.Start")]
        [InlineData(true, false, "Debug.StartWithoutDebugging")]
        [InlineData(false, true, "Debug.StopDebugging")]
        public void F5ShortcutsRouteToVisualStudio(bool control, bool shift, string expected)
        {
            Assert.True(WebViewShortcutPolicy.TryResolveVisualStudioCommand(0x74, control, shift, false, out var command));
            Assert.Equal(expected, command);
        }

        [Theory]
        [InlineData(0x74, false, false, true)]
        [InlineData(0x74, true, true, false)]
        [InlineData(0x75, false, false, false)]
        public void UnownedShortcutsRemainAvailableToTheWebView(int key, bool control, bool shift, bool alt)
        {
            Assert.False(WebViewShortcutPolicy.TryResolveVisualStudioCommand(key, control, shift, alt, out _));
        }

        [Fact]
        public void BootstrapForwardsOwnedShortcutsFromTheBrowserHwnd()
        {
            Assert.Contains("window.addEventListener('keydown'", WebviewBootstrapScript.Source);
            Assert.Contains("type: 'vscline_shortcut'", WebviewBootstrapScript.Source);
            Assert.Contains("event.preventDefault()", WebviewBootstrapScript.Source);
        }
    }
}
