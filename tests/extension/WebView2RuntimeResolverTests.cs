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

		[Fact]
		public void HighestPackagedFixedRuntimeVersionIsSelected()
		{
			using (var directory = new TemporaryDirectory())
			{
				var root = Path.Combine(directory.Path, "WebView2Runtime");
				var older = Path.Combine(root, "Microsoft.WebView2.FixedVersionRuntime.120.0.1.0.x64");
				var newer = Path.Combine(root, "Microsoft.WebView2.FixedVersionRuntime.148.0.3967.96.x64");
				Directory.CreateDirectory(older);
				Directory.CreateDirectory(newer);
				File.WriteAllBytes(Path.Combine(older, "msedgewebview2.exe"), new byte[] { 1 });
				File.WriteAllBytes(Path.Combine(newer, "msedgewebview2.exe"), new byte[] { 1 });

				var packaged = WebView2RuntimeResolver.GetWebView2RuntimeCandidates(directory.Path).Single(candidate => candidate.Label == "Bundled Fixed");
				Assert.Equal(newer, packaged.BrowserExecutableFolder);
			}
		}

		[Fact]
		public void InitializationDiagnosticDoesNotReportAnExistingFixedRuntimeAsMissing()
		{
			using (var directory = new TemporaryDirectory())
			{
				var runtime = Path.Combine(
					directory.Path,
					"WebView2Runtime",
					"Microsoft.WebView2.FixedVersionRuntime.148.0.3967.96.x64");
				Directory.CreateDirectory(runtime);
				File.WriteAllBytes(Path.Combine(runtime, "msedgewebview2.exe"), new byte[] { 1 });

				var diagnostic = WebView2RuntimeResolver.BuildWebView2InitializationError(
					new InvalidOperationException("initialization failed"),
					directory.Path,
					"System Evergreen",
					null,
					Array.Empty<string>());

				Assert.Contains("A Fixed Version Runtime was detected", diagnostic);
				Assert.DoesNotContain("No WebView2 Fixed Version Runtime was detected", diagnostic);
				Assert.Contains(runtime, diagnostic);
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
