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

            var builder = new StringBuilder();
            foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                var relativePath = file.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (IsExternalRuntimePayload(relativePath)) continue;

                var info = new FileInfo(file);
                builder.Append(relativePath.Replace('\\', '/'))
                    .Append('|').Append(info.Length)
                    .Append('|').Append(info.LastWriteTimeUtc.Ticks)
                    .AppendLine();
            }
            return builder.ToString();
        }

        public static string FromArchive(string archivePath)
        {
            if (!File.Exists(archivePath)) return "missing";
            var info = new FileInfo(archivePath);
            using (var stream = File.OpenRead(archivePath))
            using (var sha256 = SHA256.Create())
            {
                var hash = sha256.ComputeHash(stream);
                return info.Length + ":sha256:" + BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        private static bool IsExternalRuntimePayload(string relativePath)
        {
            return relativePath.StartsWith("node_modules", StringComparison.OrdinalIgnoreCase)
                || string.Equals(relativePath, "node.exe", StringComparison.OrdinalIgnoreCase)
                || string.Equals(relativePath, "node_modules.zip", StringComparison.OrdinalIgnoreCase);
        }
    }
}
