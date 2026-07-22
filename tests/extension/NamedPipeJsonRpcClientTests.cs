using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class NamedPipeJsonRpcClientTests
    {
        [Fact]
        public async Task EndOfStreamFailsPendingRequests()
        {
            var pipeName = "VsClineAgent-Test-" + Guid.NewGuid().ToString("N");
            using (var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous))
            using (var client = new NamedPipeJsonRpcClient(pipeName))
            {
                var accept = server.WaitForConnectionAsync();
                await client.ConnectAsync(5000, CancellationToken.None);
                await accept;

                var request = client.SendRequestAsync("test.pending", new { value = 1 }, CancellationToken.None);
                using (var reader = new StreamReader(server, new UTF8Encoding(false), false, 1024, true))
                    Assert.False(string.IsNullOrWhiteSpace(await reader.ReadLineAsync()));

                server.Dispose();

                var completed = await Task.WhenAny(request, Task.Delay(3000));
                Assert.Same(request, completed);
                await Assert.ThrowsAsync<EndOfStreamException>(() => request);
            }
        }

        [Fact]
        public async Task DisposeFailsPendingRequests()
        {
            var pipeName = "VsClineAgent-Test-" + Guid.NewGuid().ToString("N");
            using (var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous))
            {
                var client = new NamedPipeJsonRpcClient(pipeName);
                var accept = server.WaitForConnectionAsync();
                await client.ConnectAsync(5000, CancellationToken.None);
                await accept;

                var request = client.SendRequestAsync("test.pending", null, CancellationToken.None);
                client.Dispose();

                var error = await Record.ExceptionAsync(() => request);
                Assert.True(
                    error is ObjectDisposedException || error is OperationCanceledException,
                    "Disposing a pending pipe request must complete it with a shutdown exception.");
            }
        }
    }
}
