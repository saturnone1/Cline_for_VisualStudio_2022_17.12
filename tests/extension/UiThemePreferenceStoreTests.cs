using System;
using System.IO;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class UiThemePreferenceStoreTests
    {
        [Fact]
        public void MissingOrInvalidPreferenceFallsBackToDark()
        {
            var path = Path.Combine(Path.GetTempPath(), "ligvs-theme-" + Guid.NewGuid().ToString("N"), "theme.txt");
            var store = new UiThemePreferenceStore(path);

            Assert.Equal(UiThemePreferenceStore.DarkTheme, store.Read());
            store.Write("unexpected");
            Assert.Equal(UiThemePreferenceStore.DarkTheme, store.Read());

            Directory.Delete(Path.GetDirectoryName(path), true);
        }

        [Fact]
        public void LightPreferencePersistsAcrossInstances()
        {
            var directory = Path.Combine(Path.GetTempPath(), "ligvs-theme-" + Guid.NewGuid().ToString("N"));
            var path = Path.Combine(directory, "theme.txt");
            try
            {
                new UiThemePreferenceStore(path).Write("LIGHT");
                Assert.Equal(UiThemePreferenceStore.LightTheme, new UiThemePreferenceStore(path).Read());
            }
            finally
            {
                if (Directory.Exists(directory))
                    Directory.Delete(directory, true);
            }
        }
    }
}
