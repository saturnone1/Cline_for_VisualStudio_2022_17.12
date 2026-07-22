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
                candidates.Add(new WebView2RuntimeCandidate("Bundled Fixed", packagedRuntime));

            var localRuntimeRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VsClineAgent",
                "WebView2Runtime");
            var localRuntime = FindRuntimeFolder(localRuntimeRoot);
            CleanupUnusedFixedRuntimes(localRuntimeRoot, localRuntime);
            if (!string.IsNullOrEmpty(localRuntime) &&
                !candidates.Any(candidate => string.Equals(candidate.BrowserExecutableFolder, localRuntime, StringComparison.OrdinalIgnoreCase)))
            {
                candidates.Add(new WebView2RuntimeCandidate("Cached Fixed", localRuntime));
            }

            if (candidates.Count == 0)
                candidates.Add(new WebView2RuntimeCandidate("System Evergreen", null));

            return candidates;
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

            return Directory.EnumerateDirectories(candidateRoot)
                .Where(subDirectory => IsOfficialFixedRuntimeFolder(subDirectory) && File.Exists(Path.Combine(subDirectory, "msedgewebview2.exe")))
                .OrderByDescending(GetFixedRuntimeVersion)
                .ThenByDescending(Directory.GetLastWriteTimeUtc)
                .FirstOrDefault();
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
            CleanupVersionedCacheDirectory(Path.GetDirectoryName(profileRoot), profileVersion, 0);
            var userDataFolder = Path.Combine(
                profileRoot,
                runtimeId);
            CleanupTransientCaches(userDataFolder);
            return userDataFolder;
        }

        private static string GetWebView2ProfileVersion()
        {
            return "profile-v1";
        }

        internal static void RemoveFailedUserDataFolder(string userDataFolder)
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VsClineAgent", "WebView2Data");
            TryDeleteDirectoryUnderRoot(userDataFolder, root);
        }

        internal static void CleanupInactiveUserDataFolders(string activeUserDataFolder)
        {
            var profileRoot = Path.GetDirectoryName(activeUserDataFolder);
            if (string.IsNullOrWhiteSpace(profileRoot) || !Directory.Exists(profileRoot))
                return;
            foreach (var directory in Directory.EnumerateDirectories(profileRoot).Where(path => !string.Equals(path, activeUserDataFolder, StringComparison.OrdinalIgnoreCase)))
                TryDeleteDirectoryUnderRoot(directory, profileRoot);
        }

        private static void CleanupTransientCaches(string userDataFolder)
        {
            foreach (var relative in new[] { "Cache", "Code Cache", "GPUCache", Path.Combine("Default", "Cache"), Path.Combine("Default", "Code Cache"), Path.Combine("Default", "GPUCache") })
                TryDeleteDirectoryUnderRoot(Path.Combine(userDataFolder, relative), userDataFolder);
        }

        private static Version GetFixedRuntimeVersion(string directory)
        {
            var name = Path.GetFileName(directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            const string prefix = "Microsoft.WebView2.FixedVersionRuntime.";
            const string suffix = ".x64";
            if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) &&
                Version.TryParse(name.Substring(prefix.Length, name.Length - prefix.Length - suffix.Length), out var version))
                return version;
            return new Version(0, 0);
        }

        private static void CleanupUnusedFixedRuntimes(string runtimeRoot, string? selectedRuntime)
        {
            if (!Directory.Exists(runtimeRoot))
                return;
            foreach (var directory in Directory.EnumerateDirectories(runtimeRoot).Where(IsOfficialFixedRuntimeFolder))
            {
                if (!string.Equals(directory, selectedRuntime, StringComparison.OrdinalIgnoreCase))
                    TryDeleteDirectoryUnderRoot(directory, runtimeRoot);
            }
        }

        private static string SanitizePathSegment(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return "Default";

            foreach (var invalidChar in Path.GetInvalidFileNameChars())
                value = value.Replace(invalidChar, '_');

            return value.Replace(' ', '_');
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
            catch (Exception ex)
            {
                if (Directory.Exists(path))
                    InteractionLog.Write("host", "webview.cacheDeleteFailed", new { path, error = ex.Message });
            }
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
