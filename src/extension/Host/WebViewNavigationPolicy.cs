using System;
using System.Diagnostics;

namespace VsClineAgent.Host
{
    internal static class WebViewNavigationPolicy
    {
        public static bool ShouldOpenExternally(string? uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
                return false;

            if (string.Equals(parsed.Host, "vscline.local", StringComparison.OrdinalIgnoreCase))
                return false;

            return IsExternalScheme(parsed.Scheme);
        }

        public static bool TryOpenExternally(string? uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed) || !IsExternalScheme(parsed.Scheme))
                return false;

            try
            {
                Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true });
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsExternalScheme(string scheme)
        {
            return string.Equals(scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(scheme, Uri.UriSchemeMailto, StringComparison.OrdinalIgnoreCase);
        }
    }
}
