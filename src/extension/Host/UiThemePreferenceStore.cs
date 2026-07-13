using System;
using System.IO;

namespace VsClineAgent.Host
{
    internal sealed class UiThemePreferenceStore
    {
        public const string LightTheme = "light";
        public const string DarkTheme = "dark";

        private readonly string _path;

        public UiThemePreferenceStore(string? path = null)
        {
            _path = path ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "ui-theme.txt");
        }

        public string Read()
        {
            try
            {
                return Normalize(File.ReadAllText(_path));
            }
            catch
            {
                return DarkTheme;
            }
        }

        public void Write(string? theme)
        {
            try
            {
                var parent = Path.GetDirectoryName(_path);
                if (!string.IsNullOrWhiteSpace(parent))
                    Directory.CreateDirectory(parent);
                File.WriteAllText(_path, Normalize(theme));
            }
            catch
            {
            }
        }

        public static string Normalize(string? theme)
        {
            return string.Equals(theme?.Trim(), LightTheme, StringComparison.OrdinalIgnoreCase)
                ? LightTheme
                : DarkTheme;
        }
    }
}
