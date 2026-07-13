using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class SidecarRuntimeInstallerTests
    {
        [Fact]
        public void PrepareRefreshesRuntimeAndNodeModulesOnlyWhenFingerprintsChange()
        {
            using (var directory = new TemporaryDirectory())
            {
                var packaged = Path.Combine(directory.Path, "packaged");
                var runtime = Path.Combine(packaged, "runtime");
                Directory.CreateDirectory(runtime);
                var entrypoint = Write(Path.Combine(runtime, "cline-sidecar.js"), "first");
                var removedRuntimeFile = Write(Path.Combine(runtime, "bootstrap", "factory.js"), "factory");
                CreateNodeModulesArchive(packaged, "module-one");

                var installer = new SidecarRuntimeInstaller(Path.Combine(directory.Path, "cache"), "test-runtime");
                var first = installer.Prepare(packaged);
                Assert.True(first.RuntimeCopied);
                Assert.Equal("missing_runtime_stamp", first.RuntimeCopyReason);
                Assert.True(first.NodeModulesExtracted);
                Assert.Equal("missing_node_modules_directory", first.NodeModulesExtractReason);
                Assert.Equal("first", File.ReadAllText(Path.Combine(first.RuntimeDirectory, "cline-sidecar.js")));
                Assert.Equal("module-one", File.ReadAllText(Path.Combine(first.RuntimeDirectory, "node_modules", "sdk", "index.js")));

                var unchanged = installer.Prepare(packaged);
                Assert.False(unchanged.RuntimeCopied);
                Assert.False(unchanged.NodeModulesExtracted);

                File.WriteAllText(entrypoint, "second-runtime-version", Encoding.UTF8);
                File.SetLastWriteTimeUtc(entrypoint, DateTime.UtcNow.AddSeconds(2));
                File.Delete(removedRuntimeFile);
                var runtimeChanged = installer.Prepare(packaged);
                Assert.True(runtimeChanged.RuntimeCopied);
                Assert.Equal("runtime_stamp_mismatch", runtimeChanged.RuntimeCopyReason);
                Assert.Equal("second-runtime-version", File.ReadAllText(Path.Combine(runtimeChanged.RuntimeDirectory, "cline-sidecar.js")));
                Assert.False(File.Exists(Path.Combine(runtimeChanged.RuntimeDirectory, "bootstrap", "factory.js")));
                Assert.Equal("module-one", File.ReadAllText(Path.Combine(runtimeChanged.RuntimeDirectory, "node_modules", "sdk", "index.js")));

                CreateNodeModulesArchive(packaged, "module-two");
                var modulesChanged = installer.Prepare(packaged);
                Assert.True(modulesChanged.NodeModulesExtracted);
                Assert.Equal("node_modules_stamp_mismatch", modulesChanged.NodeModulesExtractReason);
                Assert.Equal("module-two", File.ReadAllText(Path.Combine(modulesChanged.RuntimeDirectory, "node_modules", "sdk", "index.js")));
            }
        }

        [Fact]
        public void RuntimeResolutionSupportsNestedAndRootPackageLayouts()
        {
            using (var directory = new TemporaryDirectory())
            {
                var nested = Path.Combine(directory.Path, "nested");
                var nestedRuntime = Path.Combine(nested, "runtime");
                Write(Path.Combine(nestedRuntime, "cline-sidecar.js"), "nested");
                var nestedNode = Write(Path.Combine(nestedRuntime, "node.exe"), "node");
                Assert.Equal(nestedRuntime, SidecarRuntimeInstaller.ResolvePackagedRuntimeDirectory(nested));
                Assert.Equal(nestedNode, SidecarRuntimeInstaller.ResolveBundledNodePath(nested));

                var root = Path.Combine(directory.Path, "root");
                Write(Path.Combine(root, "cline-sidecar.js"), "root");
                var rootNode = Write(Path.Combine(root, "node.exe"), "node");
                Assert.Equal(root, SidecarRuntimeInstaller.ResolvePackagedRuntimeDirectory(root));
                Assert.Equal(rootNode, SidecarRuntimeInstaller.ResolveBundledNodePath(root));
            }
        }

        private static void CreateNodeModulesArchive(string packagedDirectory, string content)
        {
            var source = Path.Combine(packagedDirectory, "node-modules-source");
            if (Directory.Exists(source)) Directory.Delete(source, true);
            Write(Path.Combine(source, "sdk", "index.js"), content);
            var archive = Path.Combine(packagedDirectory, "node_modules.zip");
            if (File.Exists(archive)) File.Delete(archive);
            ZipFile.CreateFromDirectory(source, archive, CompressionLevel.Fastest, false);
            Directory.Delete(source, true);
        }

        private static string Write(string path, string content)
        {
            var parent = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(parent)) Directory.CreateDirectory(parent);
            File.WriteAllText(path, content, Encoding.UTF8);
            return path;
        }

        private sealed class TemporaryDirectory : IDisposable
        {
            public TemporaryDirectory()
            {
                Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ligvs-runtime-test-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path);
            }

            public string Path { get; }
            public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
        }
    }
}
