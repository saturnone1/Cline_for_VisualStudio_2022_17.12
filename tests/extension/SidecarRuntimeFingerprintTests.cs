using System;
using System.IO;
using System.Text;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class SidecarRuntimeFingerprintTests
    {
        [Fact]
        public void RuntimeFingerprintChangesWithApplicationPayload()
        {
            using (var directory = new TemporaryDirectory())
            {
                var entrypoint = directory.Write("cline-sidecar.js", "first");
                var first = SidecarRuntimeFingerprint.FromRuntimeDirectory(directory.Path);
                File.WriteAllText(entrypoint, "second-version", Encoding.UTF8);
                File.SetLastWriteTimeUtc(entrypoint, DateTime.UtcNow.AddSeconds(2));
                var second = SidecarRuntimeFingerprint.FromRuntimeDirectory(directory.Path);

                Assert.NotEqual(first, second);
            }
        }

        [Fact]
        public void RuntimeFingerprintIgnoresSeparatelyVersionedNodePayloads()
        {
            using (var directory = new TemporaryDirectory())
            {
                directory.Write("cline-sidecar.js", "stable");
                var first = SidecarRuntimeFingerprint.FromRuntimeDirectory(directory.Path);
                directory.Write("node.exe", "node-one");
                directory.Write("node_modules.zip", "modules-one");
                directory.Write(Path.Combine("node_modules", "sdk", "index.js"), "sdk-one");
                var second = SidecarRuntimeFingerprint.FromRuntimeDirectory(directory.Path);

                Assert.Equal(first, second);
            }
        }

        [Fact]
        public void ArchiveFingerprintUsesContentAndLength()
        {
            using (var directory = new TemporaryDirectory())
            {
                var archive = directory.Write("node_modules.zip", "content-a");
                var first = SidecarRuntimeFingerprint.FromArchive(archive);
                File.WriteAllText(archive, "content-b", Encoding.UTF8);
                var second = SidecarRuntimeFingerprint.FromArchive(archive);

                Assert.StartsWith(new FileInfo(archive).Length + ":sha256:", second);
                Assert.NotEqual(first, second);
                Assert.Equal("missing", SidecarRuntimeFingerprint.FromArchive(Path.Combine(directory.Path, "missing.zip")));
            }
        }

        private sealed class TemporaryDirectory : IDisposable
        {
            public TemporaryDirectory()
            {
                Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ligvs-test-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path);
            }

            public string Path { get; }
            public string Write(string relativePath, string content)
            {
                var fullPath = System.IO.Path.Combine(Path, relativePath);
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(fullPath));
                File.WriteAllText(fullPath, content, Encoding.UTF8);
                return fullPath;
            }

            public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
        }
    }
}
