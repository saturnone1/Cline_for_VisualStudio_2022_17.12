using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class SidecarStartupConnectorTests
    {
        [Fact]
        public async Task ReportsProcessExitBeforeAttemptingPipeConnection()
        {
            var connectionAttempts = 0;
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() => SidecarStartupConnector.ConnectWithRetryAsync(
                () => true,
                () => "23",
                (timeout, token) => { connectionAttempts++; return Task.CompletedTask; },
                CancellationToken.None,
                retryDelayMilliseconds: 0));

            Assert.Equal(0, connectionAttempts);
            Assert.Contains("Exit code: 23", error.Message);
        }

        [Fact]
        public async Task RetriesTransientPipeFailuresUntilConnected()
        {
            var connectionAttempts = 0;
            await SidecarStartupConnector.ConnectWithRetryAsync(
                () => false,
                () => "0",
                (timeout, token) =>
                {
                    connectionAttempts++;
                    return connectionAttempts < 3
                        ? Task.FromException(new IOException("pipe not ready"))
                        : Task.CompletedTask;
                },
                CancellationToken.None,
                maximumAttempts: 3,
                retryDelayMilliseconds: 0);

            Assert.Equal(3, connectionAttempts);
        }

        [Fact]
        public async Task PreservesLastPipeFailureWhenAttemptsAreExhausted()
        {
            var error = await Assert.ThrowsAsync<TimeoutException>(() => SidecarStartupConnector.ConnectWithRetryAsync(
                () => false,
                () => "0",
                (timeout, token) => Task.FromException(new IOException("named pipe unavailable")),
                CancellationToken.None,
                maximumAttempts: 2,
                retryDelayMilliseconds: 0));

            Assert.IsType<IOException>(error.InnerException);
            Assert.Contains("named pipe unavailable", error.InnerException?.Message);
        }

        [Fact]
        public async Task HonorsCancellationBeforeConnecting()
        {
            using (var cancellation = new CancellationTokenSource())
            {
                cancellation.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => SidecarStartupConnector.ConnectWithRetryAsync(
                    () => false,
                    () => "0",
                    (timeout, token) => Task.CompletedTask,
                    cancellation.Token,
                    retryDelayMilliseconds: 0));
            }
        }
    }
}
