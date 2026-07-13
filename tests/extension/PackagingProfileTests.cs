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
