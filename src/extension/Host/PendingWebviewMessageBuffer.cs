using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal sealed class PendingWebviewMessageBuffer
    {
        private readonly int _maximumCount;
		private readonly int _hardMaximumCount;
        private readonly Queue<string> _pending = new Queue<string>();
		private int _droppedCount;

        public PendingWebviewMessageBuffer(int maximumCount = 1000, int? hardMaximumCount = null)
        {
            if (maximumCount < 1) throw new ArgumentOutOfRangeException(nameof(maximumCount));
            _maximumCount = maximumCount;
			_hardMaximumCount = hardMaximumCount ?? checked(maximumCount * 4);
			if (_hardMaximumCount < _maximumCount) throw new ArgumentOutOfRangeException(nameof(hardMaximumCount));
        }

        public int Count => _pending.Count;
		public int TakeDroppedCount() { var count = _droppedCount; _droppedCount = 0; return count; }
        public void Enqueue(string json) { _pending.Enqueue(json); Trim(); }
        public string[] TakeAll() { var messages = _pending.ToArray(); _pending.Clear(); return messages; }
        public void ReturnFailed(IEnumerable<string> messages) { foreach (var message in messages) _pending.Enqueue(message); Trim(); }
        public void Clear() => _pending.Clear();

		private void Trim()
        {
            if (_pending.Count <= _maximumCount) return;
			CoalesceReplaceableMessages();
			while (_pending.Count > _maximumCount && DropOldestReplaceableMessage()) { }
			while (_pending.Count > _hardMaximumCount) DropOldestMessage();
        }

		private void DropOldestMessage()
		{
			if (_pending.Count == 0) return;
			_pending.Dequeue();
			_droppedCount++;
		}

		private bool DropOldestReplaceableMessage()
		{
			var ordered = _pending.ToArray();
			var dropIndex = Array.FindIndex(ordered, message => TryGetReplaceableMessageKey(message) != null);
			if (dropIndex < 0) return false;

			_pending.Clear();
			for (var index = 0; index < ordered.Length; index++)
				if (index != dropIndex) _pending.Enqueue(ordered[index]);
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
            var emitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var message in ordered)
            {
				var key = TryGetReplaceableMessageKey(message);
				if (string.IsNullOrWhiteSpace(key)) { _pending.Enqueue(message); continue; }
				if (emitted.Contains(key!)) continue;
				var latest = latestByKey[key!];
				if (!string.Equals(message, latest, StringComparison.Ordinal)) continue;
				_pending.Enqueue(latest);
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
				var timestamp = payload?.Value<long?>("ts");
				return timestamp.HasValue && payload?.Value<bool?>("partial") == true
					? "partial:" + requestId + ":" + timestamp.Value
					: null;
            }
            catch { return null; }
        }
    }
}
