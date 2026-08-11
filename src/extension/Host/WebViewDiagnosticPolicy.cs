using System;

namespace VsClineAgent.Host
{
    internal static class WebViewDiagnosticPolicy
    {
        internal static bool ShouldReplaceContent(bool initialized, bool hydrated, string? kind)
        {
            if (string.Equals(kind, "fatal", StringComparison.OrdinalIgnoreCase))
                return true;

            return !initialized || !hydrated;
        }
    }
}
