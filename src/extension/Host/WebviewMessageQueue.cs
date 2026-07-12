using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal sealed class WebviewMessageQueue : IDisposable
    {
        private const int MaxPendingMessages = 1000;
        private readonly object _gate = new object();
        private readonly Queue<string> _pending = new Queue<string>();
        private readonly Dispatcher _dispatcher;
        private readonly Func<CoreWebView2?> _getWebview;
        private bool _flushScheduled;
        private bool _ready;
        private bool _disposed;

        public WebviewMessageQueue(Dispatcher dispatcher, Func<CoreWebView2?> getWebview)
        {
            _dispatcher = dispatcher;
            _getWebview = getWebview;
        }

        public bool IsReady
        {
            get { lock (_gate) return _ready; }
        }

        public void SetReady(bool ready)
        {
            lock (_gate)
            {
                if (_disposed)
                    return;
                _ready = ready;
            }
            if (ready)
                ScheduleFlush();
        }

        public void Enqueue(string json)
        {
            lock (_gate)
            {
                if (_disposed)
                    return;
                _pending.Enqueue(json);
                TrimPendingMessages();
                if (_flushScheduled)
                    return;
                _flushScheduled = true;
            }
            ScheduleFlush();
        }

        public void ScheduleFlush()
        {
            try
            {
                _dispatcher.BeginInvoke(new Action(Flush), DispatcherPriority.Background);
            }
            catch (Exception ex)
            {
                lock (_gate) _flushScheduled = false;
                InteractionLog.Write("host", "webview.queue.scheduleFailed", new { error = ex.Message });
            }
        }

        public void Clear()
        {
            lock (_gate)
            {
                _flushScheduled = false;
                _pending.Clear();
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                _disposed = true;
                _ready = false;
                _flushScheduled = false;
                _pending.Clear();
            }
        }

        private void Flush()
        {
            string[] messages;
            CoreWebView2? webview;
            lock (_gate)
            {
                _flushScheduled = false;
                if (_disposed || _pending.Count == 0)
                {
                    if (_disposed) _pending.Clear();
                    return;
                }

                webview = _getWebview();
                if (!_ready || webview == null)
                    return;

                messages = _pending.ToArray();
                _pending.Clear();
            }

            var failed = new List<string>();
            foreach (var json in messages)
            {
                try { webview.PostWebMessageAsJson(json); }
                catch (Exception ex)
                {
                    failed.Add(json);
                    InteractionLog.Write("host->webview", "webview.queue.postFailed", new
                    {
                        error = ex.Message,
                        messageLength = json.Length
                    });
                }
            }

            if (failed.Count > 0)
            {
                lock (_gate)
                {
                    foreach (var json in failed)
                        _pending.Enqueue(json);
                    TrimPendingMessages();
                }
            }
        }

        private void TrimPendingMessages()
        {
            if (_pending.Count <= MaxPendingMessages)
                return;

            CoalescePendingStateMessages();
            while (_pending.Count > MaxPendingMessages)
                _pending.Dequeue();
        }

        private void CoalescePendingStateMessages()
        {
            var latestStateByRequest = new Dictionary<string, string>(StringComparer.Ordinal);
            var ordered = _pending.ToList();
            foreach (var message in ordered)
            {
                var requestId = TryGetStateResponseRequestId(message);
                if (!string.IsNullOrWhiteSpace(requestId))
                    latestStateByRequest[requestId!] = message;
            }
            if (latestStateByRequest.Count == 0)
                return;

            _pending.Clear();
            var emitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var message in ordered)
            {
                var requestId = TryGetStateResponseRequestId(message);
                if (string.IsNullOrWhiteSpace(requestId))
                {
                    _pending.Enqueue(message);
                    continue;
                }
                if (emitted.Contains(requestId!))
                    continue;
                var latest = latestStateByRequest[requestId!];
                if (string.Equals(message, latest, StringComparison.Ordinal))
                {
                    _pending.Enqueue(latest);
                    emitted.Add(requestId!);
                }
            }
        }

        private static string? TryGetStateResponseRequestId(string json)
        {
            try
            {
                var response = (JObject.Parse(json)["grpc_response"] as JObject);
                return response?["message"]?["stateJson"] == null ? null : response.Value<string>("request_id");
            }
            catch
            {
                return null;
            }
        }
    }
}
