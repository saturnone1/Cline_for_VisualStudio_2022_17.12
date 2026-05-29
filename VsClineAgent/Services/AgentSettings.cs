namespace VsClineAgent.Services
{
    public class AgentSettings
    {
        public string LlmBaseUrl { get; set; } = "http://localhost:11434/v1";
        public string ModelName { get; set; } = "qwen3-coder:latest";
        public string ApiKey { get; set; } = "";
        public int MaxTokens { get; set; } = 8192;
        public double Temperature { get; set; } = 0.1;
        public bool AutoApprove { get; set; } = false;
        public bool ShowTokenCount { get; set; } = true;
    }
}
