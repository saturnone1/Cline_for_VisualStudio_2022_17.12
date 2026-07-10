using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal sealed class NamedPipeJsonRpcClient : IDisposable
    {
        private readonly NamedPipeClientStream _pipe;
        private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);
        private readonly object _pendingLock = new object();
        private readonly Dictionary<string, TaskCompletionSource<JToken?>> _pendingRequests =
            new Dictionary<string, TaskCompletionSource<JToken?>>();
        private StreamReader? _reader;
        private StreamWriter? _writer;
        private int _nextId;
        private CancellationTokenSource? _receiveLoopCancellation;
        private readonly SemaphoreSlim _inboundRequestSlots = new SemaphoreSlim(4, 4);

        public event Func<string, JToken?, Task<JToken?>>? RequestReceived;

        public NamedPipeJsonRpcClient(string pipeName)
        {
            var normalizedPipeName = NormalizePipeName(pipeName);
            _pipe = new NamedPipeClientStream(
                ".",
                normalizedPipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous);
        }

        public bool IsConnected => _pipe.IsConnected && _reader != null && _writer != null;

        public async Task ConnectAsync(int timeoutMilliseconds, CancellationToken cancellationToken)
        {
            await _pipe.ConnectAsync(timeoutMilliseconds, cancellationToken).ConfigureAwait(false);
            _reader = new StreamReader(_pipe, new UTF8Encoding(false));
            _writer = new StreamWriter(_pipe, new UTF8Encoding(false)) { AutoFlush = true };
            _receiveLoopCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            _ = Task.Run(() => ReceiveLoopAsync(_receiveLoopCancellation.Token));
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
            try
            {
                var reader = _reader ?? throw new IOException("Pipe reader was not initialized.");
                while (!cancellationToken.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync().ConfigureAwait(false);
                    if (line == null)
                        break;

                    if (string.IsNullOrWhiteSpace(line))
                        continue;

                    var message = JObject.Parse(line);
                    var method = (string?)message["method"];
                    if (!string.IsNullOrEmpty(method))
                    {
                        _ = Task.Run(() => HandleMessageAsync(message, cancellationToken), cancellationToken);
                    }
                    else
                    {
                        await HandleMessageAsync(message, cancellationToken).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception ex) when (!(ex is OperationCanceledException))
            {
                FailAllPendingRequests(ex);
            }
        }

        private async Task HandleMessageAsync(JObject message, CancellationToken cancellationToken)
        {
            var id = (string?)message["id"];
            var method = (string?)message["method"];

            if (!string.IsNullOrEmpty(method))
            {
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
                    : await handler(method, parameters).ConfigureAwait(false);

                await WriteMessageAsync(new JObject
                {
                    ["id"] = id,
                    ["result"] = result
                }, cancellationToken).ConfigureAwait(false);
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
            _receiveLoopCancellation?.Cancel();
            _receiveLoopCancellation?.Dispose();
            _inboundRequestSlots.Dispose();
            _writeLock.Dispose();
            _writer?.Dispose();
            _reader?.Dispose();
            _pipe.Dispose();
        }

        private static string NormalizePipeName(string pipeName)
        {
            const string prefix = @"\\.\pipe\";
            return pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? pipeName.Substring(prefix.Length)
                : pipeName;
        }
    }
}
