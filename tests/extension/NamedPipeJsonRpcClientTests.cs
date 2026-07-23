using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Generated;
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

        [Fact]
        public async Task OversizedFrameFailsPendingRequestsBeforeJsonParsing()
        {
            var pipeName = "VsClineAgent-Test-" + Guid.NewGuid().ToString("N");
            using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
            using (var client = new NamedPipeJsonRpcClient(pipeName, maximumFrameBytes: 64))
            {
                var accept = server.WaitForConnectionAsync();
                await client.ConnectAsync(5000, CancellationToken.None);
                await accept;

                var request = client.SendRequestAsync("test.pending", null, CancellationToken.None);
                using (var reader = new StreamReader(server, new UTF8Encoding(false), false, 1024, true))
                    Assert.False(string.IsNullOrWhiteSpace(await reader.ReadLineAsync()));
                using (var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, true) { AutoFlush = true })
                    await writer.WriteLineAsync(new string('x', 65));

                await Assert.ThrowsAsync<InvalidDataException>(() => request);
                Assert.False(client.IsConnected);
            }
        }

        [Fact]
        public async Task ReceiveLoopFailureInvalidatesConnectionAndRaisesClosure()
        {
            var pipeName = "VsClineAgent-Test-" + Guid.NewGuid().ToString("N");
            using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
            using (var client = new NamedPipeJsonRpcClient(pipeName))
            {
                var accept = server.WaitForConnectionAsync();
                await client.ConnectAsync(5000, CancellationToken.None);
                await accept;

                var closed = new TaskCompletionSource<Exception>(TaskCreationOptions.RunContinuationsAsynchronously);
                client.ConnectionClosed += error => closed.TrySetResult(error);
                using (var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, true) { AutoFlush = true })
                    await writer.WriteLineAsync("{not-json");

                var completed = await Task.WhenAny(closed.Task, Task.Delay(3000));
                Assert.Same(closed.Task, completed);
                Assert.IsType<Newtonsoft.Json.JsonReaderException>(await closed.Task);
                Assert.False(client.IsConnected);
            }
        }

        [Fact]
        public async Task InboundRequestAdmissionRejectsExcessWorkBeforeCreatingAnotherHandler()
        {
            var pipeName = "VsClineAgent-Test-" + Guid.NewGuid().ToString("N");
            using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
            using (var client = new NamedPipeJsonRpcClient(pipeName, maximumInboundRequests: 1))
            {
                var accept = server.WaitForConnectionAsync();
                await client.ConnectAsync(5000, CancellationToken.None);
                await accept;

                var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                var calls = 0;
                client.RequestReceived += async (_, __) =>
                {
                    Interlocked.Increment(ref calls);
                    entered.TrySetResult(true);
                    await release.Task;
                    return new JObject { ["ok"] = true };
                };

                using (var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, true) { AutoFlush = true })
                using (var reader = new StreamReader(server, new UTF8Encoding(false), false, 1024, true))
                {
                    await writer.WriteLineAsync(new JObject { ["id"] = "1", ["method"] = "host.test", ["protocolVersion"] = HostRpcContract.ProtocolVersion }.ToString(Newtonsoft.Json.Formatting.None));
                    await entered.Task;
                    await writer.WriteLineAsync(new JObject { ["id"] = "2", ["method"] = "host.test", ["protocolVersion"] = HostRpcContract.ProtocolVersion }.ToString(Newtonsoft.Json.Formatting.None));

                    var rejected = JObject.Parse(await reader.ReadLineAsync());
					Assert.Equal("2", (string?)rejected["id"]);
					Assert.Equal("host_busy", (string?)rejected["error"]?["code"]);
                    Assert.Equal(1, Volatile.Read(ref calls));

                    release.TrySetResult(true);
                    var completed = JObject.Parse(await reader.ReadLineAsync());
					Assert.Equal("1", (string?)completed["id"]);
                }
            }
        }
    }
}
