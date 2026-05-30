using System.Collections.Generic;

namespace VsClineAgent.Services
{
    public class AutoApprovalActionSettings
    {
        public bool ReadFiles { get; set; } = true;
        public bool ReadFilesExternally { get; set; } = false;
        public bool EditFiles { get; set; } = false;
        public bool EditFilesExternally { get; set; } = false;
        public bool ExecuteSafeCommands { get; set; } = true;
        public bool ExecuteAllCommands { get; set; } = false;
        public bool UseBrowser { get; set; } = false;
        public bool UseMcp { get; set; } = true;
    }

    public class AutoApprovalPreferences
    {
        public int Version { get; set; } = 1;
        public bool Enabled { get; set; } = true;
        public List<string> Favorites { get; set; } = new List<string>();
        public int MaxRequests { get; set; } = 20;
        public AutoApprovalActionSettings Actions { get; set; } = new AutoApprovalActionSettings();
        public bool EnableNotifications { get; set; } = false;
    }

    public class AgentSettings
    {
        public string LlmBaseUrl { get; set; } = "http://localhost:11434/v1";
        public string ModelName { get; set; } = "qwen3-coder:latest";
        public string ApiKey { get; set; } = "";
        public int MaxTokens { get; set; } = 8192;
        public double Temperature { get; set; } = 0.1;
        public bool AutoApprove { get; set; } = false;
        public AutoApprovalPreferences AutoApprovalSettings { get; set; } = new AutoApprovalPreferences();
        public bool EnableCheckpointsSetting { get; set; } = true;
        public bool ShowTokenCount { get; set; } = true;
    }
}
