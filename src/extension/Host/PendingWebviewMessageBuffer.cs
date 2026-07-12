using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal sealed class PendingWebviewMessageBuffer
    {
        private readonly int _maximumCount;
        private readonly Queue<string> _pending = new Queue<string>();

        public PendingWebviewMessageBuffer(int maximumCount = 1000)
        {
            if (maximumCount < 1) throw new ArgumentOutOfRangeException(nameof(maximumCount));
            _maximumCount = maximumCount;
        }

        public int Count => _pending.Count;
        public void Enqueue(string json) { _pending.Enqueue(json); Trim(); }
        public string[] TakeAll() { var messages = _pending.ToArray(); _pending.Clear(); return messages; }
        public void ReturnFailed(IEnumerable<string> messages) { foreach (var message in messages) _pending.Enqueue(message); Trim(); }
        public void Clear() => _pending.Clear();

        private void Trim()
        {
            if (_pending.Count <= _maximumCount) return;
            CoalesceStateMessages();
            while (_pending.Count > _maximumCount) _pending.Dequeue();
        }

        private void CoalesceStateMessages()
        {
            var latestStateByRequest = new Dictionary<string, string>(StringComparer.Ordinal);
            var ordered = _pending.ToList();
            foreach (var message in ordered)
            {
                var requestId = TryGetStateResponseRequestId(message);
                if (!string.IsNullOrWhiteSpace(requestId)) latestStateByRequest[requestId!] = message;
            }
            if (latestStateByRequest.Count == 0) return;

            _pending.Clear();
            var emitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var message in ordered)
            {
                var requestId = TryGetStateResponseRequestId(message);
                if (string.IsNullOrWhiteSpace(requestId)) { _pending.Enqueue(message); continue; }
                if (emitted.Contains(requestId!)) continue;
                var latest = latestStateByRequest[requestId!];
                if (!string.Equals(message, latest, StringComparison.Ordinal)) continue;
                _pending.Enqueue(latest);
                emitted.Add(requestId!);
            }
        }

        private static string? TryGetStateResponseRequestId(string json)
        {
            try
            {
                var response = JObject.Parse(json)["grpc_response"] as JObject;
                return response?["message"]?["stateJson"] == null ? null : response.Value<string>("request_id");
            }
            catch { return null; }
        }
    }
}
