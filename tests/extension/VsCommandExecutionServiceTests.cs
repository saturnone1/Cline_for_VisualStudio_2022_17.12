using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Services;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class VsCommandExecutionServiceTests
    {
        [Fact]
        public async Task ShowOutputUsesTheConfiguredVisualStudioSurface()
        {
            var output = new RecordingOutputSurface();
            using var service = new VsCommandExecutionService(output);

            Assert.True(await service.ShowOutputAsync());
            Assert.Equal(1, output.ShowCount);
        }

        [Fact]
        public async Task ShowOutputReportsUnavailableWithoutAVisualStudioSurface()
        {
            using var service = new VsCommandExecutionService();

            Assert.False(await service.ShowOutputAsync());
        }

        [Fact]
        public async Task AvailableProfilesUseVisualStudioAndWindowsShells()
        {
            using var service = new VsCommandExecutionService();

            var profiles = await service.GetAvailableProfilesAsync();

            Assert.Contains(profiles, profile => profile.Id == "visual-studio-command-host");
            Assert.Contains(profiles, profile => profile.Id == "visual-studio-developer-powershell");
            Assert.Contains(profiles, profile => profile.Id == "windows-command-prompt");
            Assert.Contains(profiles, profile => profile.Id == "windows-powershell");
        }

        [Fact]
        public async Task IndependentCommandPromptSessionReturnsOutputAndCloses()
        {
            using var service = new VsCommandExecutionService();

            var result = await service.ExecuteCommandAsync(
                "echo profile-ok",
                Path.GetTempPath(),
                10,
                CancellationToken.None,
                "windows-command-prompt",
                reuseTerminal: false);

            Assert.Equal("completed", result.Status);
            Assert.Contains("profile-ok", result.StdOut);
            Assert.Empty(await service.GetActiveCommandsAsync());
        }

        [Fact]
        public async Task CancelAllCancelsCommandsWaitingForAShellSession()
        {
            using var service = new VsCommandExecutionService(maxShellSessionsPerCwd: 1);
            var first = service.ExecuteCommandAsync("ping 127.0.0.1 -t", Path.GetTempPath(), 30, CancellationToken.None);
            await WaitForActiveCommandAsync(service);
            var waiting = service.ExecuteCommandAsync("echo waiting", Path.GetTempPath(), 30, CancellationToken.None);

            await Task.Delay(100);
            await CompleteWithinAsync(service.CancelAllAsync(), "cancel all");

            await CompleteWithinAsync(
                Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting),
                "queued command cancellation");
            var firstResult = await CompleteWithinAsync(first, "active command cancellation");
            Assert.True(firstResult.Cancelled || firstResult.Status == "cancelled");
        }

        [Fact]
        public async Task AnyCommandStillRunningAfterTheObservationWindowMovesToBackground()
        {
            using var service = new VsCommandExecutionService();

            var result = await CompleteWithinAsync(
                service.ExecuteCommandAsync(
                    "ping 127.0.0.1 -t",
                    Path.GetTempPath(),
                    1,
                    CancellationToken.None,
                    "windows-command-prompt"),
                "background transition");

            Assert.Equal("running", result.Status);
            Assert.True(result.Background);
            Assert.Single(await service.GetActiveCommandsAsync());
            Assert.Equal(1, await CompleteWithinAsync(service.CancelAllAsync(), "background cancellation"));
        }

        private static async Task CompleteWithinAsync(Task task, string operation)
        {
            if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(5))) != task)
                throw new TimeoutException(operation + " did not complete.");
            await task;
        }

        private static async Task<T> CompleteWithinAsync<T>(Task<T> task, string operation)
        {
            if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(5))) != task)
                throw new TimeoutException(operation + " did not complete.");
            return await task;
        }

        private static async Task WaitForActiveCommandAsync(VsCommandExecutionService service)
        {
            for (var attempt = 0; attempt < 50; attempt++)
            {
                if ((await service.GetActiveCommandsAsync()).Count > 0)
                    return;
                await Task.Delay(20);
            }

            throw new TimeoutException("The terminal command did not become active.");
        }

        private sealed class RecordingOutputSurface : ICommandOutputWriter, ICommandOutputSurface
        {
            public int ShowCount { get; private set; }

            public Task WriteLineAsync(string text) => Task.CompletedTask;

            public Task<bool> ShowAsync()
            {
                ShowCount++;
                return Task.FromResult(true);
            }
        }
    }
}
