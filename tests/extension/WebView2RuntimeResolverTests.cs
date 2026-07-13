using System;
using System.IO;
using System.Linq;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WebView2RuntimeResolverTests
    {
        [Fact]
        public void PackagedFixedRuntimeIsUsedDirectlyWithoutAFullCacheCopy()
        {
            using (var directory = new TemporaryDirectory())
            {
                var runtime = Path.Combine(
                    directory.Path,
                    "WebView2Runtime",
                    "Microsoft.WebView2.FixedVersionRuntime.148.0.3967.96.x64");
                Directory.CreateDirectory(runtime);
                File.WriteAllBytes(Path.Combine(runtime, "msedgewebview2.exe"), new byte[] { 1 });

                var candidates = WebView2RuntimeResolver.GetWebView2RuntimeCandidates(directory.Path);
                var packaged = candidates.Single(candidate => candidate.Label == "Bundled Fixed");

                Assert.Equal(runtime, packaged.BrowserExecutableFolder);
            }
        }

        [Fact]
        public void InvalidPackagedRuntimeFolderIsNotSelected()
        {
            using (var directory = new TemporaryDirectory())
            {
                var runtime = Path.Combine(directory.Path, "WebView2Runtime", "not-an-official-runtime");
                Directory.CreateDirectory(runtime);
                File.WriteAllBytes(Path.Combine(runtime, "msedgewebview2.exe"), new byte[] { 1 });

                var candidates = WebView2RuntimeResolver.GetWebView2RuntimeCandidates(directory.Path);

                Assert.DoesNotContain(candidates, candidate =>
                    string.Equals(candidate.BrowserExecutableFolder, runtime, StringComparison.OrdinalIgnoreCase));
            }
        }

        private sealed class TemporaryDirectory : IDisposable
        {
            public TemporaryDirectory()
            {
                Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "vscline-webview2-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path);
            }

            public string Path { get; }

            public void Dispose()
            {
                if (Directory.Exists(Path))
                    Directory.Delete(Path, true);
            }
        }
    }
}
