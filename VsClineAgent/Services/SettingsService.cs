using System;
using System.IO;
using Newtonsoft.Json;

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
                return new AgentSettings();

            try
            {
                var json = File.ReadAllText(_settingsPath);
                return JsonConvert.DeserializeObject<AgentSettings>(json) ?? new AgentSettings();
            }
            catch
            {
                return new AgentSettings();
            }
        }

        public void Save(AgentSettings settings)
        {
            var json = JsonConvert.SerializeObject(settings, Formatting.Indented);
            File.WriteAllText(_settingsPath, json);
        }
    }
}
