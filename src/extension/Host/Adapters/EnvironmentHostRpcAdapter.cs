using System;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Windows;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class EnvironmentHostRpcAdapter : IHostRpcAdapter
    {
        private readonly Action<string, string?> _writeDebugLog;

        public EnvironmentHostRpcAdapter(Action<string, string?> writeDebugLog)
        {
            _writeDebugLog = writeDebugLog;
        }

        public bool CanHandle(string method)
        {
            return method.StartsWith("env.", StringComparison.Ordinal);
        }

        public Task<JToken?> HandleAsync(string method, JToken? parameters, System.Threading.CancellationToken cancellationToken = default(System.Threading.CancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            JToken result;
            switch (method)
            {
                case "env.getPlatform":
                case "env.getHostVersion":
                    result = new JObject
                    {
                        ["platform"] = "win32",
                        ["appName"] = "Visual Studio",
                        ["host"] = "vs2022",
                        ["version"] = VisualStudioVersionInfo.Version
                    };
                    break;
                case "env.clipboardReadText":
                    result = new JObject { ["value"] = InvokeOnUiThread(() => Clipboard.GetText()) };
                    break;
                case "env.clipboardWriteText":
                    InvokeOnUiThread(() => Clipboard.SetText(GetString(parameters, "value")));
                    result = new JObject();
                    break;
                case "env.openExternal":
                    result = new JObject { ["opened"] = OpenExternal(GetExternalTarget(parameters)) };
                    break;
                case "env.debugLog":
                    _writeDebugLog("sidecar:debug", GetString(parameters, "message"));
                    result = new JObject();
                    break;
                default:
                    throw new InvalidOperationException("Unsupported environment host method: " + method);
            }

            return Task.FromResult<JToken?>(result);
        }

        private static string GetExternalTarget(JToken? parameters)
        {
            return GetString(parameters, "value", "url", "uri", "href");
        }

        private static string GetString(JToken? parameters, params string[] names)
        {
            if (!(parameters is JObject values))
                return "";

            foreach (var name in names)
            {
                var value = values.Value<string>(name);
                if (!string.IsNullOrWhiteSpace(value))
                    return value!;
            }

            return "";
        }

        private static bool OpenExternal(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return false;

            value = value.Trim();
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
                return false;

            var scheme = uri.Scheme.ToLowerInvariant();
            if (scheme != Uri.UriSchemeHttp && scheme != Uri.UriSchemeHttps && scheme != Uri.UriSchemeMailto)
                return false;

            try
            {
                Process.Start(new ProcessStartInfo { FileName = value, UseShellExecute = true });
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void InvokeOnUiThread(Action action)
        {
            var dispatcher = Application.Current?.Dispatcher;
            if (dispatcher == null || dispatcher.CheckAccess())
                action();
            else
                VisualStudioUiThread.Invoke(action);
        }

        private static T InvokeOnUiThread<T>(Func<T> action)
        {
            var dispatcher = Application.Current?.Dispatcher;
            return dispatcher == null || dispatcher.CheckAccess() ? action() : VisualStudioUiThread.Invoke(action);
        }
    }
}
