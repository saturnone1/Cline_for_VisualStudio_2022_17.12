using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace VsClineAgent.Host
{
    internal static class SidecarRuntimeFingerprint
    {
        public static string FromRuntimeDirectory(string sourceDirectory)
        {
            if (!Directory.Exists(sourceDirectory)) return "missing";

            using (var sha256 = SHA256.Create())
            {
                foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories)
                    .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
                {
                    var relativePath = file.Substring(sourceDirectory.Length)
                        .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    if (IsExternalRuntimePayload(relativePath)) continue;

                    var info = new FileInfo(file);
                    AppendUtf8(sha256, relativePath.Replace('\\', '/') + "|" + info.Length + "\n");
                    using (var stream = File.OpenRead(file))
                        AppendStream(sha256, stream);
                    AppendUtf8(sha256, "\n");
                }
                sha256.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                return "sha256:" + BitConverter.ToString(sha256.Hash!).Replace("-", "").ToLowerInvariant();
            }
        }

        public static string FromArchive(string archivePath)
        {
            if (!File.Exists(archivePath)) return "missing";
            var manifestPath = Path.Combine(Path.GetDirectoryName(archivePath) ?? "", "node_modules.fingerprint");
            if (File.Exists(manifestPath))
            {
                var manifest = File.ReadAllText(manifestPath).Trim();
                if (!string.IsNullOrWhiteSpace(manifest)) return "manifest:" + manifest;
            }
            var info = new FileInfo(archivePath);
            using (var stream = File.OpenRead(archivePath))
            using (var sha256 = SHA256.Create())
            {
                var hash = sha256.ComputeHash(stream);
                return info.Length + ":sha256:" + BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        private static void AppendUtf8(HashAlgorithm hash, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            hash.TransformBlock(bytes, 0, bytes.Length, bytes, 0);
        }

        private static void AppendStream(HashAlgorithm hash, Stream stream)
        {
            var buffer = new byte[81920];
            int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
                hash.TransformBlock(buffer, 0, count, buffer, 0);
        }

        private static bool IsExternalRuntimePayload(string relativePath)
        {
            return relativePath.StartsWith("node_modules", StringComparison.OrdinalIgnoreCase)
                || string.Equals(relativePath, "node.exe", StringComparison.OrdinalIgnoreCase)
                || string.Equals(relativePath, "node_modules.zip", StringComparison.OrdinalIgnoreCase);
        }
    }
}
