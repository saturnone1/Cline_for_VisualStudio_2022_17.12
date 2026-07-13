using System;
using System.Collections.Generic;
using Microsoft.Web.WebView2.Core;

namespace VsClineAgent.Host
{
    internal sealed class WebviewMessageQueue : IDisposable
    {
        private readonly object _gate = new object();
        private readonly PendingWebviewMessageBuffer _pending = new PendingWebviewMessageBuffer();
        private readonly Func<CoreWebView2?> _getWebview;
        private bool _flushScheduled;
        private bool _ready;
        private bool _disposed;

        public WebviewMessageQueue(Func<CoreWebView2?> getWebview)
        {
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
                VisualStudioUiThread.Post(Flush);
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

                messages = _pending.TakeAll();
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
                    _pending.ReturnFailed(failed);
                }
            }
        }
    }
}
