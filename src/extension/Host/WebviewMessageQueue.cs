using System;
using System.Collections.Generic;
using System.Threading;
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
        private Timer? _retryTimer;
		private int _retryAttempt;
		private bool _retryExhaustionLogged;
		private bool _postFailureLogged;
		private const int InitialRetryDelayMilliseconds = 100;
		private const int MaximumRetryDelayMilliseconds = 5000;
		private const int MaximumRetryAttempts = 8;

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
				if (ready)
				{
					_retryAttempt = 0;
					_retryExhaustionLogged = false;
					_postFailureLogged = false;
				}
            }
            if (ready)
                ScheduleFlush();
        }

        public void Enqueue(string json)
        {
			int dropped;
            lock (_gate)
            {
                if (_disposed)
                    return;
                _pending.Enqueue(json);
				dropped = _pending.TakeDroppedCount();
            }
			if (dropped > 0)
				InteractionLog.Write("host", "webview.queue.messagesDropped", new { count = dropped });
            ScheduleFlush();
        }

        public void ScheduleFlush()
        {
            lock (_gate)
            {
                if (_disposed || _flushScheduled)
                    return;
                _flushScheduled = true;
            }
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
            Timer? retryTimer;
            lock (_gate)
            {
                _disposed = true;
                _ready = false;
                _flushScheduled = false;
                _pending.Clear();
                retryTimer = _retryTimer;
                _retryTimer = null;
            }
            retryTimer?.Dispose();
        }

        private void Flush()
        {
            string[] messages;
            CoreWebView2? webview;
			bool webviewUnavailable;
            lock (_gate)
            {
                _flushScheduled = false;
                if (_disposed || _pending.Count == 0)
                {
                    if (_disposed) _pending.Clear();
                    return;
                }

                webview = _getWebview();
				if (!_ready)
                    return;
				webviewUnavailable = webview == null;
				messages = webviewUnavailable ? Array.Empty<string>() : _pending.TakeAll();
            }
			if (webviewUnavailable)
			{
				ScheduleRetry();
				return;
			}

            var failed = new List<string>();
			Exception? firstFailure = null;
            foreach (var json in messages)
            {
                try { webview!.PostWebMessageAsJson(json); }
                catch (Exception ex)
                {
                    failed.Add(json);
					firstFailure ??= ex;
                }
            }

            if (failed.Count > 0)
            {
				int dropped;
                lock (_gate)
                {
                    _pending.ReturnFailed(failed);
					dropped = _pending.TakeDroppedCount();
                }
				if (dropped > 0)
					InteractionLog.Write("host", "webview.queue.messagesDropped", new { count = dropped });
				lock (_gate)
				{
					if (!_postFailureLogged)
					{
						_postFailureLogged = true;
						InteractionLog.Write("host->webview", "webview.queue.postFailed", new { error = firstFailure?.Message, failed = failed.Count, pending = _pending.Count });
					}
				}
                ScheduleRetry();
            }
			else
			{
				lock (_gate)
				{
					_retryAttempt = 0;
					_retryExhaustionLogged = false;
					_postFailureLogged = false;
				}
			}
        }

        private void ScheduleRetry()
        {
            lock (_gate)
            {
                if (_disposed)
                    return;
				if (_retryAttempt >= MaximumRetryAttempts && !_retryExhaustionLogged)
				{
					_retryExhaustionLogged = true;
					InteractionLog.Write("host", "webview.queue.retryExhausted", new
					{
						attempts = _retryAttempt,
						pending = _pending.Count,
						recoveryRetryMs = MaximumRetryDelayMilliseconds
					});
				}
				var delay = Math.Min(
					InitialRetryDelayMilliseconds * (1 << Math.Min(_retryAttempt, 6)),
					MaximumRetryDelayMilliseconds);
				if (_retryAttempt < MaximumRetryAttempts) _retryAttempt++;
                if (_retryTimer == null)
					_retryTimer = new Timer(_ => ScheduleFlush(), null, delay, Timeout.Infinite);
                else
					_retryTimer.Change(delay, Timeout.Infinite);
            }
        }
    }
}
