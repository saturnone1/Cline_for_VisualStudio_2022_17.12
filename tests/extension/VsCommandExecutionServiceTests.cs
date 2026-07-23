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
        public async Task CancelAllCancelsCommandsWaitingForAShellSession()
        {
            using var service = new VsCommandExecutionService(maxShellSessionsPerCwd: 1);
            var first = service.ExecuteCommandAsync("ping 127.0.0.1 -t", Path.GetTempPath(), 30, CancellationToken.None);
            await WaitForActiveCommandAsync(service);
            var waiting = service.ExecuteCommandAsync("echo waiting", Path.GetTempPath(), 30, CancellationToken.None);

            await Task.Delay(100);
            await service.CancelAllAsync();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
            var firstResult = await first;
            Assert.True(firstResult.Cancelled || firstResult.Status == "cancelled");
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
    }
}
