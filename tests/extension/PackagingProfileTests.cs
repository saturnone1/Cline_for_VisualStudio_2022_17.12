using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class PackagingProfileTests
    {
        [Theory]
        [InlineData("17.0", "VsClineAgent17.dll")]
        [InlineData("17.12", "VsClineAgent.dll")]
        public void ProfileAssemblyNameMatchesPkgDefCodeBase(string target, string expectedAssembly)
        {
            var profileDirectory = Path.Combine(FindRepositoryRoot(), "packaging", "vs2022-" + target);
            var properties = XDocument.Load(Path.Combine(profileDirectory, "Version.props"));
            var assemblyName = properties.Descendants()
                .First(element => element.Name.LocalName == "VsAssemblyName")
                .Value.Trim() + ".dll";
            var pkgDef = File.ReadAllText(Path.Combine(profileDirectory, "VsClineAgent.pkgdef"));

            Assert.Equal(expectedAssembly, assemblyName);
            Assert.Contains("\"CodeBase\"=\"$PackageFolder$\\" + expectedAssembly + "\"", pkgDef);
        }

        [Fact]
        public void PackagingProfilesUseDistinctIdentitiesAndAdjacentRanges()
        {
            var root = FindRepositoryRoot();
            var legacy = ReadManifest(Path.Combine(root, "packaging", "vs2022-17.0", "source.extension.vsixmanifest"));
            var current = ReadManifest(Path.Combine(root, "packaging", "vs2022-17.12", "source.extension.vsixmanifest"));

            Assert.NotEqual(legacy.Identity.ToUpperInvariant(), current.Identity.ToUpperInvariant());
            Assert.Equal("[17.0,17.12)", legacy.InstallationRange);
            Assert.Equal("[17.12,19.0)", current.InstallationRange);
        }

        [Fact]
        public void ExtensionProjectUsesProfileAssemblyName()
        {
            var project = XDocument.Load(Path.Combine(FindRepositoryRoot(), "src", "extension", "VsClineAgent.csproj"));
            var assemblyName = project.Descendants()
                .First(element => element.Name.LocalName == "AssemblyName")
                .Value.Trim();

            Assert.Equal("$(VsAssemblyName)", assemblyName);
        }

        [Fact]
        public void ProductVersionIsSynchronizedFromOneCanonicalProperty()
        {
            var root = FindRepositoryRoot();
            var versionProperties = XDocument.Load(Path.Combine(root, "packaging", "ProductVersion.props"));
            var version = versionProperties.Descendants().First(element => element.Name.LocalName == "ProductVersion").Value.Trim();
            var assemblyVersion = versionProperties.Descendants().First(element => element.Name.LocalName == "ProductAssemblyVersion").Value.Trim();
            foreach (var target in new[] { "17.0", "17.12" })
            {
                var manifest = XDocument.Load(Path.Combine(root, "packaging", "vs2022-" + target, "source.extension.vsixmanifest"));
                Assert.Equal(version, manifest.Descendants().First(element => element.Name.LocalName == "Identity").Attribute("Version")?.Value);
            }

            var generated = File.ReadAllText(Path.Combine(root, "src", "extension", "Properties", "ProductVersionAssemblyInfo.cs"));
            Assert.Contains("AssemblyVersion(\"" + assemblyVersion + "\")", generated);
            Assert.Contains("AssemblyInformationalVersion(\"" + version + "\")", generated);
        }

        [Fact]
        public void ToolWindowDelegatesLoadingPresentationAndHasNoTimingBasedUnloadState()
        {
            var source = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "extension", "ToolWindows", "ChatToolWindowControl.xaml.cs"));
            Assert.Contains("WebViewLoadingPresenter", source);
            Assert.Contains("ToolWindowLifetime", source);
            Assert.DoesNotContain("ScheduleUnloadDispose", source);
            Assert.DoesNotContain("TimeSpan.FromSeconds", source);
        }

		[Fact]
		public void ToolWindowPreparesTheSidecarBeforeCreatingWebViewAndCanRetryInitialization()
		{
			var source = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "extension", "ToolWindows", "ChatToolWindowControl.xaml.cs"));
			var initializationMethod = source.IndexOf("private async Task<bool> InitializeWebViewAsync()", StringComparison.Ordinal);
			Assert.True(initializationMethod >= 0);
			var sidecarStart = source.IndexOf("await _sidecar.EnsureRunningAsync()", initializationMethod, StringComparison.Ordinal);
			var webViewRuntimeResolution = source.IndexOf("WebView2RuntimeResolver.GetWebView2RuntimeCandidates", initializationMethod, StringComparison.Ordinal);

			Assert.True(sidecarStart > initializationMethod && webViewRuntimeResolution > sidecarStart);
			Assert.Contains("_initialized = await InitializeWebViewAsync()", source);
			Assert.Contains("_initializing = false;", source);
		}

        [Fact]
        public void ExtensionProjectCompilesCriticalHostLifecycleSources()
        {
            var project = XDocument.Load(Path.Combine(FindRepositoryRoot(), "src", "extension", "VsClineAgent.csproj"));
            var compileItems = project.Descendants()
                .Where(element => element.Name.LocalName == "Compile")
                .Select(element => ((string?)element.Attribute("Include") ?? "").Replace('/', '\\'))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            Assert.Contains("Host\\SidecarProcess.cs", compileItems);
            Assert.Contains("Host\\ToolWindowLifetime.cs", compileItems);
            Assert.Contains("ToolWindows\\ChatToolWindowControl.xaml.cs", compileItems);
            Assert.Contains("Services\\VsCommandExecutionService.cs", compileItems);
        }

        [Fact]
        public void BackgroundCommandLoggingDoesNotOpenOrActivateTheOutputPane()
        {
            var source = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "extension", "Host", "VisualStudioOutputPaneWriter.cs"));
            Assert.Contains("CreatePane(ref outputPaneGuid, \"VsCline Agent\", 0, 1)", source);
            Assert.DoesNotContain("pane?.Activate()", source);
        }

        private static PackagingManifest ReadManifest(string path)
        {
            var document = XDocument.Load(path);
            var identity = document.Descendants().First(element => element.Name.LocalName == "Identity");
            var installationTarget = document.Descendants().First(element => element.Name.LocalName == "InstallationTarget");
            return new PackagingManifest(
                identity.Attribute("Id")?.Value ?? "",
                installationTarget.Attribute("Version")?.Value ?? "");
        }

        private static string FindRepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                if (Directory.Exists(Path.Combine(directory.FullName, "packaging")) &&
                    File.Exists(Path.Combine(directory.FullName, "src", "extension", "VsClineAgent.csproj")))
                    return directory.FullName;
                directory = directory.Parent;
            }

            throw new DirectoryNotFoundException("Could not locate the LIG VS repository root.");
        }

        private sealed class PackagingManifest
        {
            public PackagingManifest(string identity, string installationRange)
            {
                Identity = identity;
                InstallationRange = installationRange;
            }

            public string Identity { get; }
            public string InstallationRange { get; }
        }
    }
}
