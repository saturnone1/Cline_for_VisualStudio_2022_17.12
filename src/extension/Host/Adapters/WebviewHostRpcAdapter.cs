using System;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class WebviewHostRpcAdapter : IHostRpcAdapter
    {
        private readonly Func<Func<object, Task>?> _getPostToWebviewAsync;

        public WebviewHostRpcAdapter(Func<Func<object, Task>?> getPostToWebviewAsync)
        {
            _getPostToWebviewAsync = getPostToWebviewAsync;
        }

        public bool CanHandle(string method)
        {
            return method == "webview.postMessage";
        }

        public async Task<JToken?> HandleAsync(string method, JToken? parameters)
        {
            if (!CanHandle(method))
                throw new InvalidOperationException("Unsupported WebView host method: " + method);

            var post = _getPostToWebviewAsync();
            var message = (parameters as JObject)?["message"];
            if (post != null && message != null)
            {
                InteractionLog.Write("host->webview", "webview.postMessage", message);
                await post(message).ConfigureAwait(false);
            }

            return new JObject { ["posted"] = true };
        }
    }
}
