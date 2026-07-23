using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;

namespace VsClineAgent.Host
{
    internal sealed class SidecarRuntimePreparation
    {
        public string RuntimeDirectory { get; set; } = "";
        public long TotalMs { get; set; }
        public long RuntimeStampMs { get; set; }
        public bool RuntimeCopied { get; set; }
        public long RuntimeCopyMs { get; set; }
        public string RuntimeCopyReason { get; set; } = "";
        public bool NodeModulesExtracted { get; set; }
        public long NodeModulesExtractMs { get; set; }
        public string NodeModulesExtractReason { get; set; } = "";
    }

    internal sealed class SidecarRuntimeInstaller
    {
        private readonly string _cacheBaseDirectory;
        private readonly string _runtimeVersion;

        public SidecarRuntimeInstaller(string? cacheBaseDirectory = null, string? runtimeVersion = null)
        {
            _cacheBaseDirectory = cacheBaseDirectory ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "Sidecar");
            _runtimeVersion = SanitizeCacheVersion(runtimeVersion ?? GetConfiguredRuntimeCacheVersion());
        }

        public SidecarRuntimePreparation Prepare(string packagedSidecarDirectory)
        {
            if (string.IsNullOrWhiteSpace(packagedSidecarDirectory))
                throw new ArgumentException("Packaged sidecar directory is required.", nameof(packagedSidecarDirectory));

            var totalStopwatch = Stopwatch.StartNew();
            using var preparationLock = AcquirePreparationLock(
                _cacheBaseDirectory,
                TimeSpan.FromMilliseconds(ReadPreparationLockTimeoutMilliseconds()));
            var nodeModulesZip = Path.Combine(packagedSidecarDirectory, "node_modules.zip");
            var runtimeSourceDirectory = ResolvePackagedRuntimeDirectory(packagedSidecarDirectory);
            var cacheRoot = Path.Combine(_cacheBaseDirectory, _runtimeVersion);
            RetryPendingDeletes(_cacheBaseDirectory, _runtimeVersion);
            CleanupVersionedCacheDirectory(_cacheBaseDirectory, _runtimeVersion, 1);
            var nodeModulesDirectory = Path.Combine(cacheRoot, "node_modules");
            var stampPath = Path.Combine(cacheRoot, ".node_modules.stamp");
            var runtimeStampPath = Path.Combine(cacheRoot, ".runtime.stamp");
            var expectedStamp = SidecarRuntimeFingerprint.FromArchive(nodeModulesZip);
            var runtimeStampStopwatch = Stopwatch.StartNew();
            var expectedRuntimeStamp = SidecarRuntimeFingerprint.FromRuntimeDirectory(runtimeSourceDirectory);
            runtimeStampStopwatch.Stop();

            var preparation = new SidecarRuntimePreparation
            {
                RuntimeDirectory = cacheRoot,
                RuntimeStampMs = runtimeStampStopwatch.ElapsedMilliseconds
            };

            preparation.RuntimeCopyReason = !File.Exists(runtimeStampPath)
                ? "missing_runtime_stamp"
                : !string.Equals(File.ReadAllText(runtimeStampPath), expectedRuntimeStamp, StringComparison.Ordinal)
                    ? "runtime_stamp_mismatch"
                    : "";
            if (!string.IsNullOrEmpty(preparation.RuntimeCopyReason))
            {
                var runtimeCopyStopwatch = Stopwatch.StartNew();
                ClearCachedRuntimeFiles(cacheRoot);
                CopyRuntimeFiles(runtimeSourceDirectory, cacheRoot);
                runtimeCopyStopwatch.Stop();
                preparation.RuntimeCopied = true;
                preparation.RuntimeCopyMs = runtimeCopyStopwatch.ElapsedMilliseconds;
                Directory.CreateDirectory(cacheRoot);
                File.WriteAllText(runtimeStampPath, expectedRuntimeStamp);
            }

            preparation.NodeModulesExtractReason = !Directory.Exists(nodeModulesDirectory)
                ? "missing_node_modules_directory"
                : !File.Exists(stampPath)
                    ? "missing_node_modules_stamp"
                    : !string.Equals(File.ReadAllText(stampPath), expectedStamp, StringComparison.Ordinal)
                        ? "node_modules_stamp_mismatch"
                        : "";
            if (!string.IsNullOrEmpty(preparation.NodeModulesExtractReason))
            {
                if (!File.Exists(nodeModulesZip))
                    throw new FileNotFoundException("Cline SDK dependency archive was not found.", nodeModulesZip);

                Directory.CreateDirectory(cacheRoot);
                if (Directory.Exists(nodeModulesDirectory))
                    Directory.Delete(nodeModulesDirectory, true);

                var extractStopwatch = Stopwatch.StartNew();
                ZipFile.ExtractToDirectory(nodeModulesZip, nodeModulesDirectory);
                extractStopwatch.Stop();
                preparation.NodeModulesExtracted = true;
                preparation.NodeModulesExtractMs = extractStopwatch.ElapsedMilliseconds;
                File.WriteAllText(stampPath, expectedStamp);
            }

            totalStopwatch.Stop();
            preparation.TotalMs = totalStopwatch.ElapsedMilliseconds;
            return preparation;
        }

        internal static IDisposable AcquirePreparationLock(string cacheBaseDirectory, TimeSpan timeout)
        {
            if (string.IsNullOrWhiteSpace(cacheBaseDirectory))
                throw new ArgumentException("Sidecar cache directory is required.", nameof(cacheBaseDirectory));
            if (timeout <= TimeSpan.Zero)
                throw new ArgumentOutOfRangeException(nameof(timeout));

            Directory.CreateDirectory(cacheBaseDirectory);
            var lockPath = Path.Combine(cacheBaseDirectory, ".prepare.lock");
            var stopwatch = Stopwatch.StartNew();
            IOException? lastError = null;
            while (stopwatch.Elapsed < timeout)
            {
                try
                {
                    return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                }
                catch (IOException ex)
                {
                    lastError = ex;
                    Thread.Sleep(100);
                }
            }

            throw new TimeoutException(
                "Timed out waiting for another Visual Studio instance to finish preparing the LIG VS sidecar runtime.",
                lastError);
        }

        public static string ResolvePackagedRuntimeDirectory(string packagedSidecarDirectory)
        {
            var rootEntrypoint = Path.Combine(packagedSidecarDirectory, "cline-sidecar.js");
            if (File.Exists(rootEntrypoint))
                return packagedSidecarDirectory;

            var nestedRuntimeDirectory = Path.Combine(packagedSidecarDirectory, "runtime");
            var nestedEntrypoint = Path.Combine(nestedRuntimeDirectory, "cline-sidecar.js");
            return File.Exists(nestedEntrypoint) ? nestedRuntimeDirectory : packagedSidecarDirectory;
        }

        public static string ResolveBundledNodePath(string packagedSidecarDirectory)
        {
            var rootNodePath = Path.Combine(packagedSidecarDirectory, "node.exe");
            if (File.Exists(rootNodePath))
                return rootNodePath;

            var runtimeNodePath = Path.Combine(packagedSidecarDirectory, "runtime", "node.exe");
            return File.Exists(runtimeNodePath) ? runtimeNodePath : "node";
        }

        public static string BuildMissingEntrypointDiagnostic(string packagedSidecarDirectory, string runtimeDirectory)
        {
            var packagedEntrypoint = Path.Combine(packagedSidecarDirectory, "cline-sidecar.js");
            var packagedRuntimeEntrypoint = Path.Combine(packagedSidecarDirectory, "runtime", "cline-sidecar.js");
            var cachedEntrypoint = Path.Combine(runtimeDirectory, "cline-sidecar.js");
            return "Cline sidecar entrypoint was not found. Checked: "
                + packagedEntrypoint + "; " + packagedRuntimeEntrypoint + "; " + cachedEntrypoint;
        }

        private static string GetConfiguredRuntimeCacheVersion()
        {
            var configured = Environment.GetEnvironmentVariable("VSCLINE_SIDECAR_CACHE_KEY");
            return string.IsNullOrWhiteSpace(configured) ? GetDefaultRuntimeCacheVersion() : configured!;
        }

        private static int ReadPreparationLockTimeoutMilliseconds()
        {
            var configured = Environment.GetEnvironmentVariable("VSCLINE_SIDECAR_PREPARE_LOCK_TIMEOUT_MS");
            return int.TryParse(configured, out var value) && value >= 1000 && value <= 600000
                ? value
                : 180000;
        }

        private static string GetDefaultRuntimeCacheVersion()
        {
            var assemblyName = Assembly.GetExecutingAssembly().GetName();
            var name = string.IsNullOrWhiteSpace(assemblyName.Name) ? "VsClineAgent" : assemblyName.Name!;
            var version = assemblyName.Version?.ToString() ?? "unknown";
            return name + "-" + version;
        }

        private static string SanitizeCacheVersion(string cacheVersion)
        {
            foreach (var invalidChar in Path.GetInvalidFileNameChars())
                cacheVersion = cacheVersion.Replace(invalidChar, '_');
            return cacheVersion.Replace(' ', '_');
        }

        private static void CleanupVersionedCacheDirectory(string cacheRoot, string currentVersion, int keepRecentCount)
        {
            if (string.IsNullOrWhiteSpace(cacheRoot) || !Directory.Exists(cacheRoot))
                return;

            var root = Path.GetFullPath(cacheRoot);
            var candidates = Directory.EnumerateDirectories(root)
                .Select(path => new DirectoryInfo(path))
                .Where(info => !string.Equals(info.Name, currentVersion, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(info => info.LastWriteTimeUtc)
                .Skip(Math.Max(0, keepRecentCount))
                .ToList();
            foreach (var candidate in candidates)
            {
                if (!TryDeleteDirectoryUnderRoot(candidate.FullName, root))
                    RecordPendingDelete(root, candidate.FullName);
            }
        }

        private static bool TryDeleteDirectoryUnderRoot(string path, string root)
        {
            try
            {
                var resolved = Path.GetFullPath(path);
                var resolvedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;
                if (resolved.StartsWith(resolvedRoot, StringComparison.OrdinalIgnoreCase))
                {
                    Directory.Delete(resolved, true);
                    return true;
                }
            }
            catch (Exception ex)
            {
                InteractionLog.Write("host", "sidecar.cacheDeleteFailed", new { path, error = ex.Message });
            }
            return false;
        }

        private static void RetryPendingDeletes(string cacheRoot, string currentVersion)
        {
            var pendingPath = Path.Combine(cacheRoot, ".pending-delete");
            if (!File.Exists(pendingPath))
                return;
            var remaining = File.ReadAllLines(pendingPath).Where(path =>
                !string.Equals(Path.GetFileName(path), currentVersion, StringComparison.OrdinalIgnoreCase) &&
                Directory.Exists(path) && !TryDeleteDirectoryUnderRoot(path, cacheRoot)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (remaining.Length == 0)
                File.Delete(pendingPath);
            else
                File.WriteAllLines(pendingPath, remaining);
        }

        private static void RecordPendingDelete(string cacheRoot, string directory)
        {
            try
            {
                Directory.CreateDirectory(cacheRoot);
                var pendingPath = Path.Combine(cacheRoot, ".pending-delete");
                var entries = File.Exists(pendingPath) ? File.ReadAllLines(pendingPath).ToList() : new System.Collections.Generic.List<string>();
                if (!entries.Contains(directory, StringComparer.OrdinalIgnoreCase))
                    entries.Add(directory);
                File.WriteAllLines(pendingPath, entries);
            }
            catch (Exception ex)
            {
                InteractionLog.Write("host", "sidecar.pendingDeleteWriteFailed", new { directory, error = ex.Message });
            }
        }

        private static void CopyRuntimeFiles(string sourceDirectory, string targetDirectory)
        {
            Directory.CreateDirectory(targetDirectory);
            foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories))
            {
                var relativePath = file.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (relativePath.StartsWith("node_modules", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(relativePath, "node.exe", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(relativePath, "node_modules.zip", StringComparison.OrdinalIgnoreCase))
                    continue;

                var targetPath = Path.Combine(targetDirectory, relativePath);
                var targetParent = Path.GetDirectoryName(targetPath);
                if (!string.IsNullOrWhiteSpace(targetParent))
                    Directory.CreateDirectory(targetParent);
                File.Copy(file, targetPath, true);
            }
        }

        private static void ClearCachedRuntimeFiles(string cacheRoot)
        {
            if (!Directory.Exists(cacheRoot))
                return;

            foreach (var file in Directory.EnumerateFiles(cacheRoot))
            {
                var name = Path.GetFileName(file);
                if (string.Equals(name, ".node_modules.stamp", StringComparison.OrdinalIgnoreCase))
                    continue;
                File.Delete(file);
            }

            foreach (var directory in Directory.EnumerateDirectories(cacheRoot))
            {
                if (string.Equals(Path.GetFileName(directory), "node_modules", StringComparison.OrdinalIgnoreCase))
                    continue;
                Directory.Delete(directory, true);
            }
        }
    }
}
