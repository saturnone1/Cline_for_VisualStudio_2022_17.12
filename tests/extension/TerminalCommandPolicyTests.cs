using VsClineAgent.Services;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class TerminalCommandPolicyTests
    {
        [Fact]
        public void BuildsStableTerminalAndShellStateLabels()
        {
            Assert.Equal("vs-command-host:workspace:1", TerminalCommandPolicy.BuildTerminalId("", 1));
            Assert.Equal("vs-command-host:project:2", TerminalCommandPolicy.BuildTerminalId(@"C:\work\project\", 2));
            Assert.Equal("idle", TerminalCommandPolicy.BuildShellState(0, 0));
            Assert.Equal("idle (1 reusable session)", TerminalCommandPolicy.BuildShellState(1, 0));
            Assert.Equal("busy (2/3 reusable sessions)", TerminalCommandPolicy.BuildShellState(3, 2));
        }
    }
}
