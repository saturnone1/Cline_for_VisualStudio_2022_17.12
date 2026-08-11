using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal sealed class PendingWebviewMessageBuffer
    {
        private readonly int _maximumCount;
		private readonly int _hardMaximumCount;
		private readonly long _maximumBytes;
		private readonly long _hardMaximumBytes;
        private readonly Queue<BufferedMessage> _pending = new Queue<BufferedMessage>();
		private int _droppedCount;
		private long _pendingBytes;

        public PendingWebviewMessageBuffer(int maximumCount = 1000, int? hardMaximumCount = null, long maximumBytes = 32L * 1024 * 1024, long? hardMaximumBytes = null)
        {
            if (maximumCount < 1) throw new ArgumentOutOfRangeException(nameof(maximumCount));
			_maximumCount = maximumCount;
			_hardMaximumCount = hardMaximumCount ?? checked(maximumCount * 4);
			if (_hardMaximumCount < _maximumCount) throw new ArgumentOutOfRangeException(nameof(hardMaximumCount));
			if (maximumBytes < 1) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
			_maximumBytes = maximumBytes;
			_hardMaximumBytes = hardMaximumBytes ?? checked(maximumBytes * 2);
			if (_hardMaximumBytes < _maximumBytes) throw new ArgumentOutOfRangeException(nameof(hardMaximumBytes));
        }

        public int Count => _pending.Count;
		public long ByteCount => _pendingBytes;
		public int TakeDroppedCount() { var count = _droppedCount; _droppedCount = 0; return count; }
        public void Enqueue(string json) { EnqueueCoalesced(json); Trim(); }
        public string[] TakeAll() { var messages = _pending.Select(message => message.Json).ToArray(); _pending.Clear(); _pendingBytes = 0; return messages; }
        public void ReturnFailed(IEnumerable<string> messages)
        {
			var returned = messages?.ToArray() ?? Array.Empty<string>();
			if (returned.Length == 0) return;

			// A failed delivery predates anything enqueued while the flush was in flight.
			// Put it back at the front so unary replies and lifecycle events cannot be
			// observed in a different order after a transient WebView failure.
			var queued = _pending.Select(message => message.Json).ToArray();
			_pending.Clear();
			_pendingBytes = 0;
			foreach (var message in returned) EnqueueCoalesced(message);
			foreach (var message in queued) EnqueueCoalesced(message);
			Trim();
		}
        public void Clear() { _pending.Clear(); _pendingBytes = 0; }

		private void Trim()
        {
			if (_pending.Count <= _maximumCount && _pendingBytes <= _maximumBytes) return;
			while ((_pending.Count > _maximumCount || _pendingBytes > _maximumBytes) && DropOldestReplaceableMessage()) { }
			while (_pending.Count > _hardMaximumCount || _pendingBytes > _hardMaximumBytes) DropOldestMessage();
        }

		private void EnqueueCoalesced(string json)
		{
			var key = TryGetReplaceableMessageKey(json);
			if (key != null && _pending.Any(message => string.Equals(message.ReplaceableKey, key, StringComparison.Ordinal)))
			{
				var retained = _pending.Where(message => !string.Equals(message.ReplaceableKey, key, StringComparison.Ordinal)).ToArray();
				_pending.Clear();
				_pendingBytes = 0;
				foreach (var message in retained) Add(message);
			}
			Add(new BufferedMessage(json, key));
		}

		private void Add(BufferedMessage message)
		{
			_pending.Enqueue(message);
			_pendingBytes += message.ByteCount;
		}

		private void DropOldestMessage()
		{
			if (_pending.Count == 0) return;
			_pendingBytes -= _pending.Dequeue().ByteCount;
			_droppedCount++;
		}

		private bool DropOldestReplaceableMessage()
		{
			var ordered = _pending.ToArray();
			var dropIndex = Array.FindIndex(ordered, message => message.ReplaceableKey != null);
			if (dropIndex < 0) return false;

			_pending.Clear();
			_pendingBytes = 0;
			for (var index = 0; index < ordered.Length; index++)
				if (index != dropIndex) Add(ordered[index]);
			_droppedCount++;
			return true;
		}

		private static string? TryGetReplaceableMessageKey(string json)
        {
            try
            {
                var response = JObject.Parse(json)["grpc_response"] as JObject;
				if (response == null || response.Value<bool?>("is_streaming") != true) return null;
				var requestId = response.Value<string>("request_id");
				if (string.IsNullOrWhiteSpace(requestId)) return null;
				var payload = response["message"] as JObject;
				if (payload?["stateJson"] != null) return "state:" + requestId;
				var partial = payload?["message"] as JObject ?? payload;
				var timestamp = partial?.Value<long?>("ts");
				return timestamp.HasValue && partial?.Value<bool?>("partial") == true
					? "partial:" + requestId + ":" + timestamp.Value
					: null;
            }
            catch { return null; }
        }

		private sealed class BufferedMessage
		{
			public BufferedMessage(string json, string? replaceableKey)
			{
				Json = json ?? string.Empty;
				ReplaceableKey = replaceableKey;
				ByteCount = Encoding.UTF8.GetByteCount(Json);
			}

			public string Json { get; }
			public string? ReplaceableKey { get; }
			public int ByteCount { get; }
		}
    }
}
