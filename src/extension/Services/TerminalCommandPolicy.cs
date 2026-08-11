using System;
using System.IO;

namespace VsClineAgent.Services
{
    internal static class TerminalCommandPolicy
    {
        public static string BuildTerminalId(string workingDirectory, int ordinal, string? profileId = null)
        {
            var trimmed = string.IsNullOrWhiteSpace(workingDirectory)
                ? ""
                : workingDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var name = string.IsNullOrWhiteSpace(trimmed) ? "workspace" : Path.GetFileName(trimmed);
            var workspaceName = string.IsNullOrWhiteSpace(name) ? "workspace" : name;
            if (string.IsNullOrWhiteSpace(profileId))
                return "vs-command-host:" + workspaceName + ":" + ordinal;

            var profile = profileId!.Replace("visual-studio-", "vs-").Replace("windows-", "win-");
            return "vs-command-host:" + profile + ":" + workspaceName + ":" + ordinal;
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
