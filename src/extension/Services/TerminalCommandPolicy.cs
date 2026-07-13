using System;
using System.IO;

namespace VsClineAgent.Services
{
    internal static class TerminalCommandPolicy
    {
        public static bool IsLikelyLongRunning(string command)
        {
            var text = (command ?? string.Empty).ToLowerInvariant();
            return text.Contains(" dotnet watch") ||
                   text.StartsWith("dotnet watch", StringComparison.Ordinal) ||
                   text.Contains(" npm run dev") ||
                   text.StartsWith("npm run dev", StringComparison.Ordinal) ||
                   text.Contains(" npm start") ||
                   text.StartsWith("npm start", StringComparison.Ordinal) ||
                   text.Contains(" vite") ||
                   text.Contains(" webpack serve") ||
                   text.Contains("ng serve") ||
                   text.Contains("yarn dev") ||
                   text.Contains("pnpm dev");
        }

        public static string BuildTerminalId(string workingDirectory, int ordinal)
        {
            var trimmed = string.IsNullOrWhiteSpace(workingDirectory)
                ? ""
                : workingDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var name = string.IsNullOrWhiteSpace(trimmed) ? "workspace" : Path.GetFileName(trimmed);
            return "vs-command-host:" + (string.IsNullOrWhiteSpace(name) ? "workspace" : name) + ":" + ordinal;
        }

        public static string BuildShellState(int sessionCount, int busyCount)
        {
            if (sessionCount <= 0)
                return "idle";
            return busyCount <= 0
                ? $"idle ({sessionCount} reusable session{(sessionCount == 1 ? "" : "s")})"
                : $"busy ({busyCount}/{sessionCount} reusable sessions)";
        }
    }
}
