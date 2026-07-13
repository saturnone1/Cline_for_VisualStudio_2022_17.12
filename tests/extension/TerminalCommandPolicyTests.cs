using VsClineAgent.Services;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class TerminalCommandPolicyTests
    {
        [Theory]
        [InlineData("dotnet watch")]
        [InlineData("cd app && npm run dev")]
        [InlineData("pnpm dev")]
        [InlineData("ng serve")]
        public void DetectsLikelyLongRunningCommands(string command)
        {
            Assert.True(TerminalCommandPolicy.IsLikelyLongRunning(command));
        }

        [Theory]
        [InlineData("dotnet build")]
        [InlineData("npm test")]
        [InlineData("dir")]
        public void LeavesFiniteCommandsInForeground(string command)
        {
            Assert.False(TerminalCommandPolicy.IsLikelyLongRunning(command));
        }

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
