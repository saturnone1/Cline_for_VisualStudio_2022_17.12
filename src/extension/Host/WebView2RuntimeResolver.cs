using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.Web.WebView2.Core;

namespace VsClineAgent.Host
{
    internal static class WebView2RuntimeResolver
    {
        internal static string BuildWebView2InitializationError(
            Exception ex,
            string assemblyDirectory,
            string? runtimeLabel,
            string? browserExecutableFolder,
            IReadOnlyCollection<string> initializationFailures)
        {
            var bundledRuntimeRoot = Path.Combine(assemblyDirectory, "WebView2Runtime");
            var localRuntimeRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime");

            var detail = string.IsNullOrEmpty(browserExecutableFolder)
                ? "No bundled WebView2 Fixed Version Runtime was detected."
                : $"{runtimeLabel ?? "WebView2"} runtime was detected at:\n{browserExecutableFolder}";
            var failures = initializationFailures.Count == 0
                ? string.Empty
                : "\n\nAttempts:\n" + string.Join("\n", initializationFailures);
            var assembly = Assembly.GetExecutingAssembly();
            var assemblyVersion = GetDisplayAssemblyVersion(assembly);
            var assemblyLocation = assembly.Location;
            var localRuntime = FindRuntimeFolder(localRuntimeRoot) ?? "(none)";
            var packagedRuntime = FindRuntimeFolder(bundledRuntimeRoot) ?? "(none)";

            return
                $"WebView2 init failed:\n{ex.Message}\nHRESULT: 0x{ex.HResult:X8}\n" +
                $"VsClineAgent assembly: {assemblyVersion}\n{assemblyLocation}\n\n" +
                $"{detail}\n\nDetected runtime folders:\n" +
                $"Packaged: {packagedRuntime}\n" +
                $"Local: {localRuntime}{failures}\n\n" +
                "For air-gapped use, bundle or extract a WebView2 Fixed Version Runtime so msedgewebview2.exe exists under one of these locations:\n" +
                $"{bundledRuntimeRoot}\\Microsoft.WebView2.FixedVersionRuntime.<version>.x64\\msedgewebview2.exe\n" +
                $"{localRuntimeRoot}\\Microsoft.WebView2.FixedVersionRuntime.<version>.x64\\msedgewebview2.exe";
        }

        internal static IReadOnlyList<WebView2RuntimeCandidate> GetWebView2RuntimeCandidates(string assemblyDirectory)
        {
            var candidates = new List<WebView2RuntimeCandidate>();
            if (IsWebView2RuntimeAvailable(null))
                candidates.Add(new WebView2RuntimeCandidate("System Evergreen", null));

            var packagedRuntime = FindRuntimeFolder(Path.Combine(assemblyDirectory, "WebView2Runtime"));
            if (!string.IsNullOrEmpty(packagedRuntime))
            {
                var localRuntime = CopyWebView2RuntimeToLocalCache(packagedRuntime!);
                if (!string.IsNullOrEmpty(localRuntime))
                    candidates.Add(new WebView2RuntimeCandidate("Bundled Fixed", localRuntime));
            }

            var existingBundledRuntime = FindBundledWebView2Runtime(assemblyDirectory);
            if (!string.IsNullOrEmpty(existingBundledRuntime) &&
                !candidates.Any(candidate => string.Equals(candidate.BrowserExecutableFolder, existingBundledRuntime, StringComparison.OrdinalIgnoreCase)))
            {
                candidates.Add(new WebView2RuntimeCandidate("Bundled Fixed", existingBundledRuntime));
            }

            if (candidates.Count == 0)
                candidates.Add(new WebView2RuntimeCandidate("System Evergreen", null));

            return candidates;
        }

        private static string? FindBundledWebView2Runtime(string assemblyDirectory)
        {
            foreach (var candidateRoot in GetWebView2RuntimeCandidateRoots(assemblyDirectory))
            {
                var runtimeFolder = FindRuntimeFolder(candidateRoot);
                if (!string.IsNullOrEmpty(runtimeFolder))
                    return runtimeFolder;
            }

            return null;
        }

        private static IEnumerable<string> GetWebView2RuntimeCandidateRoots(string assemblyDirectory)
        {
            yield return Path.Combine(assemblyDirectory, "WebView2Runtime");
            yield return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime");
        }

        private static string? FindRuntimeFolder(string candidateRoot)
        {
            if (string.IsNullOrWhiteSpace(candidateRoot) || !Directory.Exists(candidateRoot))
                return null;

            if (IsOfficialFixedRuntimeFolder(candidateRoot) &&
                File.Exists(Path.Combine(candidateRoot, "msedgewebview2.exe")))
            {
                return candidateRoot;
            }

            foreach (var subDirectory in Directory.EnumerateDirectories(candidateRoot))
            {
                if (IsOfficialFixedRuntimeFolder(subDirectory) &&
                    File.Exists(Path.Combine(subDirectory, "msedgewebview2.exe")))
                {
                    return subDirectory;
                }
            }

            return null;
        }

        private static bool IsOfficialFixedRuntimeFolder(string runtimeFolder)
        {
            var name = Path.GetFileName(runtimeFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            return name.StartsWith("Microsoft.WebView2.FixedVersionRuntime.", StringComparison.OrdinalIgnoreCase) &&
                name.EndsWith(".x64", StringComparison.OrdinalIgnoreCase);
        }

        internal static string GetWebView2UserDataFolder(string runtimeLabel, string? browserExecutableFolder)
        {
            var runtimeId = string.IsNullOrWhiteSpace(browserExecutableFolder)
                ? SanitizePathSegment(runtimeLabel)
                : Path.GetFileName(browserExecutableFolder!.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) ?? "Bundled";

            runtimeId = SanitizePathSegment(runtimeId);
            var profileVersion = GetWebView2ProfileVersion();
            var profileRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Data",
                profileVersion);
            CleanupVersionedCacheDirectory(Path.GetDirectoryName(profileRoot), profileVersion, 2);
            return Path.Combine(
                profileRoot,
                runtimeId);
        }

        private static string GetWebView2ProfileVersion()
        {
            var assemblyName = Assembly.GetExecutingAssembly().GetName();
            var name = string.IsNullOrWhiteSpace(assemblyName.Name) ? "VsClineAgent" : assemblyName.Name!;
            var version = assemblyName.Version?.ToString() ?? "unknown";
            return SanitizePathSegment(name + "-" + version);
        }

        private static string SanitizePathSegment(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return "Default";

            foreach (var invalidChar in Path.GetInvalidFileNameChars())
                value = value.Replace(invalidChar, '_');

            return value.Replace(' ', '_');
        }

        private static string? CopyWebView2RuntimeToLocalCache(string sourceRuntimeFolder)
        {
            var version = Path.GetFileName(sourceRuntimeFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            if (string.IsNullOrWhiteSpace(version))
                return null;

            var targetRuntimeFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime",
                version);
            var stampPath = Path.Combine(targetRuntimeFolder, ".runtime.stamp");
            var expectedStamp = GetRuntimeStamp(sourceRuntimeFolder);

            if (File.Exists(Path.Combine(targetRuntimeFolder, "msedgewebview2.exe")) &&
                File.Exists(stampPath) &&
                string.Equals(File.ReadAllText(stampPath), expectedStamp, StringComparison.Ordinal))
            {
                return targetRuntimeFolder;
            }

            if (Directory.Exists(targetRuntimeFolder))
                Directory.Delete(targetRuntimeFolder, true);

            CopyDirectory(sourceRuntimeFolder, targetRuntimeFolder);
            File.WriteAllText(stampPath, expectedStamp);
            CleanupVersionedCacheDirectory(Path.GetDirectoryName(targetRuntimeFolder), version, 1);
            return targetRuntimeFolder;
        }

        private static void CleanupVersionedCacheDirectory(string? cacheRoot, string currentVersion, int keepRecentCount)
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
                TryDeleteDirectoryUnderRoot(candidate.FullName, root);
        }

        private static void TryDeleteDirectoryUnderRoot(string path, string root)
        {
            try
            {
                var resolved = Path.GetFullPath(path);
                var resolvedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;
                if (!resolved.StartsWith(resolvedRoot, StringComparison.OrdinalIgnoreCase))
                    return;

                Directory.Delete(resolved, true);
            }
            catch
            {
            }
        }

        private static void CopyDirectory(string sourceDirectory, string targetDirectory)
        {
            Directory.CreateDirectory(targetDirectory);

            foreach (var directory in Directory.EnumerateDirectories(sourceDirectory, "*", SearchOption.AllDirectories))
            {
                var relativeDirectory = directory.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                Directory.CreateDirectory(Path.Combine(targetDirectory, relativeDirectory));
            }

            foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories))
            {
                var relativeFile = file.Substring(sourceDirectory.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var targetFile = Path.Combine(targetDirectory, relativeFile);
                var targetParent = Path.GetDirectoryName(targetFile);
                if (!string.IsNullOrWhiteSpace(targetParent))
                    Directory.CreateDirectory(targetParent);

                File.Copy(file, targetFile, true);
            }
        }

        private static string GetRuntimeStamp(string runtimeFolder)
        {
            var exePath = Path.Combine(runtimeFolder, "msedgewebview2.exe");
            var info = new FileInfo(exePath);
            if (!info.Exists)
                return "missing";

            var fileCount = 0;
            long totalBytes = 0;
            foreach (var file in Directory.EnumerateFiles(runtimeFolder, "*", SearchOption.AllDirectories))
            {
                var fileInfo = new FileInfo(file);
                fileCount++;
                totalBytes += fileInfo.Length;
            }

            return info.Length + ":" + info.LastWriteTimeUtc.Ticks + ":" + fileCount + ":" + totalBytes;
        }

        internal static void EnsureWebView2RuntimeAvailable(string? browserExecutableFolder)
        {
            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString(browserExecutableFolder);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                throw;
            }
        }

        private static bool IsWebView2RuntimeAvailable(string? browserExecutableFolder)
        {
            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString(browserExecutableFolder);
                return true;
            }
            catch (WebView2RuntimeNotFoundException)
            {
                return false;
            }
        }

        internal sealed class WebView2RuntimeCandidate
        {
            public WebView2RuntimeCandidate(string label, string? browserExecutableFolder)
            {
                Label = label;
                BrowserExecutableFolder = browserExecutableFolder;
            }

            public string Label { get; }

            public string? BrowserExecutableFolder { get; }
        }

        private static string GetDisplayAssemblyVersion(Assembly assembly)
        {
            var informationalVersion = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            return !string.IsNullOrWhiteSpace(informationalVersion)
                ? informationalVersion!
                : assembly.GetName().Version?.ToString() ?? "unknown";
        }
    }
}
