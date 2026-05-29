using System.Collections.Generic;
using Newtonsoft.Json;

namespace VsClineAgent.Agent.Models
{
    // OpenAI-compatible chat message models — Cline uses plain text content
    // (tool calls are embedded as XML in the assistant message text, not OpenAI function_calling)
    public class ChatMessage
    {
        [JsonProperty("role")]
        public string Role { get; set; } = "";

        [JsonProperty("content")]
        public string Content { get; set; } = "";

        public static ChatMessage System(string content) =>
            new ChatMessage { Role = "system", Content = content };

        public static ChatMessage User(string content) =>
            new ChatMessage { Role = "user", Content = content };

        public static ChatMessage Assistant(string content) =>
            new ChatMessage { Role = "assistant", Content = content };
    }

    public class ChatRequest
    {
        [JsonProperty("model")]
        public string Model { get; set; }

        [JsonProperty("messages")]
        public List<ChatMessage> Messages { get; set; }

        [JsonProperty("stream")]
        public bool Stream { get; set; } = false;

        [JsonProperty("temperature")]
        public double Temperature { get; set; } = 0.1;

        [JsonProperty("max_tokens", NullValueHandling = NullValueHandling.Ignore)]
        public int? MaxTokens { get; set; }
    }

    public class ChatChoice
    {
        [JsonProperty("message")]
        public ChatMessage Message { get; set; }

        [JsonProperty("finish_reason")]
        public string FinishReason { get; set; }
    }

    public class ChatResponse
    {
        [JsonProperty("choices")]
        public List<ChatChoice> Choices { get; set; }

        [JsonProperty("usage")]
        public ChatUsage Usage { get; set; }
    }

    public class ChatUsage
    {
        [JsonProperty("prompt_tokens")]
        public int PromptTokens { get; set; }

        [JsonProperty("completion_tokens")]
        public int CompletionTokens { get; set; }

        [JsonProperty("total_tokens")]
        public int TotalTokens { get; set; }
    }
}
