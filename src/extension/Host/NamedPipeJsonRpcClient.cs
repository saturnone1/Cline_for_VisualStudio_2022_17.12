using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Generated;

namespace VsClineAgent.Host
{
    internal sealed class NamedPipeJsonRpcClient : IDisposable
    {
        private const int DefaultMaximumFrameBytes = 32 * 1024 * 1024;
        private const int DefaultMaximumInboundRequests = 128;
        private readonly NamedPipeClientStream _pipe;
        private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);
        private readonly object _pendingLock = new object();
        private readonly Dictionary<string, TaskCompletionSource<JToken?>> _pendingRequests =
            new Dictionary<string, TaskCompletionSource<JToken?>>();
        private readonly int _maximumFrameBytes;
        private readonly int _maximumInboundRequests;
        private BoundedUtf8LineReader? _reader;
        private StreamWriter? _writer;
        private int _nextId;
        private CancellationTokenSource? _receiveLoopCancellation;
        private Task? _receiveLoopTask;
        private readonly SemaphoreSlim _inboundRequestSlots = new SemaphoreSlim(4, 4);
        private int _inboundRequests;
        private int _receiveLoopRunning;
        private int _disposed;

        public event Func<string, JToken?, CancellationToken, Task<JToken?>>? RequestReceived;
        public event Action<Exception>? ConnectionClosed;

        public NamedPipeJsonRpcClient(
            string pipeName,
            int? maximumFrameBytes = null,
            int? maximumInboundRequests = null)
        {
            var resolvedMaximumFrameBytes = maximumFrameBytes ?? ReadBoundedPositiveIntEnvironment(
                "VSCLINE_RPC_MAX_FRAME_BYTES", DefaultMaximumFrameBytes, 1024 * 1024, 128 * 1024 * 1024);
            var resolvedMaximumInboundRequests = maximumInboundRequests ?? ReadBoundedPositiveIntEnvironment(
                "VSCLINE_HOST_MAX_INBOUND_REQUESTS", DefaultMaximumInboundRequests, 1, 2048);
            if (resolvedMaximumFrameBytes < 1)
                throw new ArgumentOutOfRangeException(nameof(maximumFrameBytes));
            if (resolvedMaximumInboundRequests < 1)
                throw new ArgumentOutOfRangeException(nameof(maximumInboundRequests));
            _maximumFrameBytes = resolvedMaximumFrameBytes;
            _maximumInboundRequests = resolvedMaximumInboundRequests;
            var normalizedPipeName = NormalizePipeName(pipeName);
            _pipe = new NamedPipeClientStream(
                ".",
                normalizedPipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous);
        }

        public bool IsConnected =>
            Volatile.Read(ref _disposed) == 0 &&
            Volatile.Read(ref _receiveLoopRunning) != 0 &&
            _pipe.IsConnected &&
            _reader != null &&
            _writer != null;

        public async Task ConnectAsync(int timeoutMilliseconds, CancellationToken cancellationToken)
        {
            await _pipe.ConnectAsync(timeoutMilliseconds, cancellationToken).ConfigureAwait(false);
            _reader = new BoundedUtf8LineReader(_pipe, _maximumFrameBytes);
            _writer = new StreamWriter(_pipe, new UTF8Encoding(false)) { AutoFlush = true };
            _receiveLoopCancellation = new CancellationTokenSource();
            Volatile.Write(ref _receiveLoopRunning, 1);
            _receiveLoopTask = Task.Run(() => ReceiveLoopAsync(_receiveLoopCancellation.Token));
        }

        public async Task<JToken?> SendRequestAsync(
            string method,
            object? parameters,
            CancellationToken cancellationToken)
        {
            var id = Interlocked.Increment(ref _nextId).ToString();
            var completion = new TaskCompletionSource<JToken?>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            var request = new JObject
            {
                ["id"] = id,
                ["method"] = method,
                ["params"] = parameters == null ? null : JToken.FromObject(parameters)
            };

            lock (_pendingLock)
            {
                _pendingRequests[id] = completion;
            }

            using (cancellationToken.Register(() => CancelPendingRequest(id)))
            {
                try
                {
                    await WriteMessageAsync(request, cancellationToken).ConfigureAwait(false);
                    return await completion.Task.ConfigureAwait(false);
                }
                finally
                {
                    lock (_pendingLock)
                    {
                        _pendingRequests.Remove(id);
                    }
                }
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
        {
            Exception? terminalError = null;
            try
            {
                var reader = _reader ?? throw new IOException("Pipe reader was not initialized.");
                while (!cancellationToken.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                    if (line == null)
                    {
                        terminalError = new EndOfStreamException("The LIG VS sidecar closed the named pipe.");
                        break;
                    }

                    if (string.IsNullOrWhiteSpace(line))
                        continue;

                    var message = JObject.Parse(line);
                    var method = (string?)message["method"];
                    if (!string.IsNullOrEmpty(method))
                    {
                        if (Interlocked.Increment(ref _inboundRequests) > _maximumInboundRequests)
                        {
                            Interlocked.Decrement(ref _inboundRequests);
                            await WriteMessageAsync(new JObject
                            {
                                ["id"] = message["id"],
                                ["error"] = new JObject
                                {
                                    ["code"] = "host_busy",
                                    ["message"] = "The Visual Studio host request queue is full."
                                }
                            }, cancellationToken).ConfigureAwait(false);
                            continue;
                        }
                        _ = Task.Run(() => RunInboundMessageAsync(message, cancellationToken));
                    }
                    else
                    {
                        await HandleMessageAsync(message, cancellationToken).ConfigureAwait(false);
                    }
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
            catch (OperationCanceledException ex)
            {
                terminalError = new IOException(
                    "The LIG VS sidecar connection ended while receiving a host request.",
                    ex);
            }
            catch (Exception ex)
            {
                terminalError = ex;
            }
            finally
            {
                // Every inbound handler belongs to this connection. Once the receive loop
                // ends, no handler can deliver a valid response, regardless of whether the
                // loop ended through EOF, transport failure, or local shutdown.
                _receiveLoopCancellation?.Cancel();
                Volatile.Write(ref _receiveLoopRunning, 0);
                if (terminalError != null)
                    FailAllPendingRequests(terminalError);
                else if (cancellationToken.IsCancellationRequested)
                    FailAllPendingRequests(new OperationCanceledException("The LIG VS sidecar connection was closed."));

                if (Volatile.Read(ref _disposed) == 0)
                {
                    var closure = terminalError ?? new IOException("The LIG VS sidecar connection stopped receiving messages.");
                    try { ConnectionClosed?.Invoke(closure); } catch { }
                }
            }
        }

        private async Task RunInboundMessageAsync(JObject message, CancellationToken cancellationToken)
        {
            try
            {
                await HandleMessageAsync(message, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
            catch
            {
                // The receive loop owns connection failure. Inbound request failures are returned by the handler.
            }
            finally
            {
                Interlocked.Decrement(ref _inboundRequests);
            }
        }

        private async Task HandleMessageAsync(JObject message, CancellationToken cancellationToken)
        {
            var id = (string?)message["id"];
            var method = (string?)message["method"];

            if (!string.IsNullOrEmpty(method))
            {
                var protocolVersion = (int?)message["protocolVersion"];
                if (protocolVersion != HostRpcContract.ProtocolVersion)
                {
                    await WriteMessageAsync(new JObject
                    {
                        ["id"] = id,
                        ["error"] = new JObject
                        {
                            ["code"] = "unsupported_host_protocol",
                            ["message"] = "Unsupported Host RPC protocol version."
                        }
                    }, cancellationToken).ConfigureAwait(false);
                    return;
                }
                await HandleInboundRequestAsync(id, method!, message["params"], cancellationToken)
                    .ConfigureAwait(false);
                return;
            }

            if (string.IsNullOrEmpty(id))
                return;

            TaskCompletionSource<JToken?>? completion;
            lock (_pendingLock)
            {
                _pendingRequests.TryGetValue(id!, out completion);
            }

            if (completion == null)
                return;

            var error = message["error"];
            if (error != null && error.Type != JTokenType.Null)
                completion.TrySetException(new InvalidOperationException(error.ToString(Formatting.None)));
            else
                completion.TrySetResult(message["result"]);
        }

        private async Task HandleInboundRequestAsync(
            string? id,
            string method,
            JToken? parameters,
            CancellationToken cancellationToken)
        {
            if (string.IsNullOrEmpty(id))
                return;

            await _inboundRequestSlots.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var handler = RequestReceived;
                var result = handler == null
                    ? null
                    : await handler(method, parameters, cancellationToken).ConfigureAwait(false);

                await WriteMessageAsync(new JObject
                {
                    ["id"] = id,
                    ["result"] = result
                }, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                await WriteMessageAsync(new JObject
                {
                    ["id"] = id,
                    ["error"] = new JObject
                    {
                        ["code"] = "host_request_failed",
                        ["message"] = ex.Message
                    }
                }, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _inboundRequestSlots.Release();
            }
        }

        private async Task WriteMessageAsync(JObject message, CancellationToken cancellationToken)
        {
            await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);

            try
            {
                if (!IsConnected || _writer == null)
                    throw new IOException("Named pipe is not connected.");

                await _writer.WriteLineAsync(message.ToString(Formatting.None)).ConfigureAwait(false);
            }
            finally
            {
                _writeLock.Release();
            }
        }

        private void CancelPendingRequest(string id)
        {
            TaskCompletionSource<JToken?>? completion;
            lock (_pendingLock)
            {
                _pendingRequests.TryGetValue(id, out completion);
            }

            completion?.TrySetCanceled();
        }

        private void FailAllPendingRequests(Exception ex)
        {
            List<TaskCompletionSource<JToken?>> completions;
            lock (_pendingLock)
            {
                completions = new List<TaskCompletionSource<JToken?>>(_pendingRequests.Values);
                _pendingRequests.Clear();
            }

            foreach (var completion in completions)
                completion.TrySetException(ex);
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;

            Volatile.Write(ref _receiveLoopRunning, 0);
            _receiveLoopCancellation?.Cancel();
            FailAllPendingRequests(new ObjectDisposedException(nameof(NamedPipeJsonRpcClient)));
            try { _pipe.Dispose(); } catch { }
            _receiveLoopCancellation?.Dispose();
            try { _writer?.Dispose(); } catch { }

            // Inbound handlers may still be unwinding after pipe disposal. Disposing their
            // semaphores here can turn a normal shutdown into an unobserved ObjectDisposedException.
            _receiveLoopTask = null;
            ConnectionClosed = null;
            RequestReceived = null;
        }

        private static string NormalizePipeName(string pipeName)
        {
            const string prefix = @"\\.\pipe\";
            return pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? pipeName.Substring(prefix.Length)
                : pipeName;
        }

        private static int ReadBoundedPositiveIntEnvironment(string name, int fallback, int minimum, int maximum)
        {
            int parsed;
            var value = Environment.GetEnvironmentVariable(name);
            if (!int.TryParse(value, out parsed) || parsed < 1)
                parsed = fallback;
            return Math.Min(maximum, Math.Max(minimum, parsed));
        }
    }
}
