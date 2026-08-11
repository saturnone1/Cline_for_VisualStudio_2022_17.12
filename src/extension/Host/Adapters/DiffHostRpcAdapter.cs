using System;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Services;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class DiffHostRpcAdapter : IHostRpcAdapter
    {
        private readonly VsEditorService _editorService;

        public DiffHostRpcAdapter(VsEditorService editorService)
        {
            _editorService = editorService;
        }

        public bool CanHandle(string method)
        {
            return method == "diff.openDiff" || method == "diff.closeAllDiffs";
        }

        public async Task<JToken?> HandleAsync(string method, JToken? parameters, System.Threading.CancellationToken cancellationToken = default(System.Threading.CancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            switch (method)
            {
                case "diff.closeAllDiffs":
                    return new JObject { ["success"] = true };
                case "diff.openDiff":
                    return await OpenDiffAsync(parameters).ConfigureAwait(false);
                default:
                    throw new InvalidOperationException("Unsupported diff host method: " + method);
            }
        }

        private async Task<JObject> OpenDiffAsync(JToken? parameters)
        {
            var leftPath = GetString(parameters, "leftPath");
            var rightPath = GetString(parameters, "rightPath");
            if (!string.IsNullOrWhiteSpace(leftPath) && !string.IsNullOrWhiteSpace(rightPath))
            {
                await _editorService.ExecuteCommandAsync(
                    "Tools.DiffFiles",
                    QuoteCommandArgument(leftPath) + " " + QuoteCommandArgument(rightPath)).ConfigureAwait(false);
                return new JObject { ["success"] = true };
            }

            if (!string.IsNullOrWhiteSpace(leftPath))
                await _editorService.OpenFileAsync(leftPath).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(rightPath))
                await _editorService.OpenFileAsync(rightPath).ConfigureAwait(false);

            return new JObject { ["success"] = true };
        }

        private static string QuoteCommandArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static string GetString(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<string>(name) ?? "" : "";
        }
    }
}
