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
        private readonly Queue<string> _pending = new Queue<string>();
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
        public string[] TakeAll() { var messages = _pending.ToArray(); _pending.Clear(); _pendingBytes = 0; return messages; }
        public void ReturnFailed(IEnumerable<string> messages) { foreach (var message in messages) EnqueueCoalesced(message); Trim(); }
        public void Clear() { _pending.Clear(); _pendingBytes = 0; }

		private void Trim()
        {
			if (_pending.Count <= _maximumCount && _pendingBytes <= _maximumBytes) return;
			CoalesceReplaceableMessages();
			while ((_pending.Count > _maximumCount || _pendingBytes > _maximumBytes) && DropOldestReplaceableMessage()) { }
			while (_pending.Count > _hardMaximumCount || _pendingBytes > _hardMaximumBytes) DropOldestMessage();
        }

		private void EnqueueCoalesced(string json)
		{
			var key = TryGetReplaceableMessageKey(json);
			if (key != null && _pending.Any(message => string.Equals(TryGetReplaceableMessageKey(message), key, StringComparison.Ordinal)))
			{
				var retained = _pending.Where(message => !string.Equals(TryGetReplaceableMessageKey(message), key, StringComparison.Ordinal)).ToArray();
				_pending.Clear();
				_pendingBytes = 0;
				foreach (var message in retained) Add(message);
			}
			Add(json);
		}

		private void Add(string message)
		{
			_pending.Enqueue(message);
			_pendingBytes += MessageBytes(message);
		}

		private void DropOldestMessage()
		{
			if (_pending.Count == 0) return;
			_pendingBytes -= MessageBytes(_pending.Dequeue());
			_droppedCount++;
		}

		private bool DropOldestReplaceableMessage()
		{
			var ordered = _pending.ToArray();
			var dropIndex = Array.FindIndex(ordered, message => TryGetReplaceableMessageKey(message) != null);
			if (dropIndex < 0) return false;

			_pending.Clear();
			_pendingBytes = 0;
			for (var index = 0; index < ordered.Length; index++)
				if (index != dropIndex) Add(ordered[index]);
			_droppedCount++;
			return true;
		}

		private void CoalesceReplaceableMessages()
        {
			var latestByKey = new Dictionary<string, string>(StringComparer.Ordinal);
            var ordered = _pending.ToList();
            foreach (var message in ordered)
            {
				var key = TryGetReplaceableMessageKey(message);
				if (!string.IsNullOrWhiteSpace(key)) latestByKey[key!] = message;
            }
			if (latestByKey.Count == 0) return;

            _pending.Clear();
			_pendingBytes = 0;
            var emitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var message in ordered)
            {
				var key = TryGetReplaceableMessageKey(message);
				if (string.IsNullOrWhiteSpace(key)) { Add(message); continue; }
				if (emitted.Contains(key!)) continue;
				var latest = latestByKey[key!];
				if (!string.Equals(message, latest, StringComparison.Ordinal)) continue;
				Add(latest);
				emitted.Add(key!);
            }
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

		private static int MessageBytes(string message) => Encoding.UTF8.GetByteCount(message ?? string.Empty);
    }
}
