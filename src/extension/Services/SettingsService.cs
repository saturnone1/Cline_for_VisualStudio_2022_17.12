using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Services
{
    internal class SettingsService
    {
        private readonly string _settingsPath;

        public SettingsService()
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "VsClineAgent");
            Directory.CreateDirectory(dir);
            _settingsPath = Path.Combine(dir, "settings.json");
        }

        public AgentSettings Load()
        {
            if (!File.Exists(_settingsPath))
                return Normalize(new AgentSettings(), hasGranularSettings: true);

            try
            {
                var json = File.ReadAllText(_settingsPath);
                var parsed = JObject.Parse(json);
                var settings = parsed.ToObject<AgentSettings>() ?? new AgentSettings();
                return Normalize(settings, parsed["AutoApprovalSettings"] != null);
            }
            catch
            {
                return Normalize(new AgentSettings(), hasGranularSettings: true);
            }
        }

        public void Save(AgentSettings settings)
        {
            settings = Normalize(settings ?? new AgentSettings(), hasGranularSettings: true);
            var json = JsonConvert.SerializeObject(settings, Formatting.Indented);
            File.WriteAllText(_settingsPath, json);
        }

        private static AgentSettings Normalize(AgentSettings settings, bool hasGranularSettings)
        {
            settings ??= new AgentSettings();
            settings.AutoApprovalSettings ??= new AutoApprovalPreferences();
            settings.AutoApprovalSettings.Favorites ??= new System.Collections.Generic.List<string>();
            settings.AutoApprovalSettings.Actions ??= new AutoApprovalActionSettings();

            if (settings.AutoApprovalSettings.Version <= 0)
                settings.AutoApprovalSettings.Version = 1;

            if (settings.AutoApprovalSettings.MaxRequests <= 0)
                settings.AutoApprovalSettings.MaxRequests = 20;

            if (!hasGranularSettings && settings.AutoApprove)
            {
                settings.AutoApprovalSettings.Enabled = true;
                settings.AutoApprovalSettings.Actions.EditFiles = true;
                settings.AutoApprovalSettings.Actions.ExecuteSafeCommands = true;
            }

            settings.AutoApprove = settings.AutoApprovalSettings.Enabled && settings.AutoApprovalSettings.Actions != null &&
                new[]
                {
                    settings.AutoApprovalSettings.Actions.EditFiles,
                    settings.AutoApprovalSettings.Actions.EditFilesExternally,
                    settings.AutoApprovalSettings.Actions.ExecuteSafeCommands,
                    settings.AutoApprovalSettings.Actions.ExecuteAllCommands,
                    settings.AutoApprovalSettings.Actions.UseBrowser,
                    settings.AutoApprovalSettings.Actions.UseMcp,
                }.Any(value => value);

            return settings;
        }
    }
}
