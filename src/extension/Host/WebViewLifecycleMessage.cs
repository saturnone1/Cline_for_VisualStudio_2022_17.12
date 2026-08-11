using System;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host
{
    internal static class WebViewLifecycleMessage
    {
        internal static bool IsHydrated(string rawJson)
        {
            if (string.IsNullOrWhiteSpace(rawJson))
                return false;

            try
            {
                var message = JObject.Parse(rawJson);
                return message.Value<int?>("protocol_version") == 1 &&
                    string.Equals(message.Value<string>("type"), "vscline.webview.hydrated", StringComparison.Ordinal);
            }
            catch
            {
                return false;
            }
        }
    }
}
