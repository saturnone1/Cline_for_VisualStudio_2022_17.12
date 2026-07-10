using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VsClineAgent.Agent.Models;
using VsClineAgent.Services;

namespace VsClineAgent.Agent
{
    // Ollama / OpenAI-compatible HTTP client.
    // Cline sends plain-text messages; XML tool calls are embedded in assistant text.
    internal class LlmClient : IDisposable
    {
        private readonly HttpClient _http;
        private string _baseUrl = "http://localhost:11434/v1";
        private string _model = "qwen3-coder:latest";
        private int _maxTokens = 8192;
        private double _temperature = 0.1;

        public LlmClient()
        {
            _http = new HttpClient();
            _http.Timeout = TimeSpan.FromMinutes(10);
        }

        public void Configure(AgentSettings settings)
        {
            _baseUrl = settings.LlmBaseUrl.TrimEnd('/');
            _model = settings.ModelName;
            _maxTokens = settings.MaxTokens;
            _temperature = settings.Temperature;

            if (!string.IsNullOrEmpty(settings.ApiKey))
                _http.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", settings.ApiKey);
        }

        // Non-streaming completion. Returns the full assistant text.
        public async Task<string> ChatAsync(
            List<ChatMessage> messages,
            CancellationToken ct = default)
        {
            var request = new ChatRequest
            {
                Model = _model,
                Messages = messages,
                Stream = false,
                MaxTokens = _maxTokens,
                Temperature = _temperature,
            };

            var json = JsonConvert.SerializeObject(request, Formatting.None,
                new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore });

            var content = new StringContent(json, Encoding.UTF8, "application/json");

            HttpResponseMessage response;
            try
            {
                response = await _http.PostAsync($"{_baseUrl}/chat/completions", content, ct);
            }
            catch (TaskCanceledException)
            {
                throw new OperationCanceledException("LLM request cancelled or timed out.");
            }
            catch (HttpRequestException ex)
            {
                throw new InvalidOperationException(
                    $"Cannot connect to LLM at {_baseUrl}. Is Ollama running?\n{ex.Message}", ex);
            }

            var body = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                string errMsg;
                try { errMsg = JObject.Parse(body)["error"]?["message"]?.ToString() ?? body; }
                catch { errMsg = body; }
                throw new InvalidOperationException($"LLM error {(int)response.StatusCode}: {errMsg}");
            }

            var resp = JsonConvert.DeserializeObject<ChatResponse>(body);
            return resp?.Choices?[0]?.Message?.Content
                ?? throw new InvalidOperationException("Empty response from LLM");
        }

        // Streaming completion — calls onToken for each text delta.
        public async Task StreamChatAsync(
            List<ChatMessage> messages,
            Action<string> onToken,
            Action onDone,
            CancellationToken ct = default)
        {
            var request = new
            {
                model = _model,
                messages,
                stream = true,
                temperature = _temperature,
                max_tokens = _maxTokens,
            };

            var json = JsonConvert.SerializeObject(request,
                new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore });

            var reqMsg = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/chat/completions")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };

            using var response = await _http.SendAsync(reqMsg, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();

            using var stream = await response.Content.ReadAsStreamAsync();
            using var reader = new System.IO.StreamReader(stream);

            while (!reader.EndOfStream && !ct.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync();
                if (line == null) continue;
                if (!line.StartsWith("data: ")) continue;

                var data = line.Substring(6).Trim();
                if (data == "[DONE]") break;
                if (string.IsNullOrEmpty(data)) continue;

                try
                {
                    var obj = JObject.Parse(data);
                    var delta = obj["choices"]?[0]?["delta"]?["content"]?.ToString();
                    if (delta != null) onToken(delta);
                }
                catch { /* malformed SSE chunk */ }
            }

            onDone?.Invoke();
        }

        public async Task<bool> CheckConnectionAsync(CancellationToken ct = default)
        {
            try
            {
                var resp = await _http.GetAsync($"{_baseUrl}/models", ct);
                return resp.IsSuccessStatusCode;
            }
            catch { return false; }
        }

        public void Dispose() => _http.Dispose();
    }
}
