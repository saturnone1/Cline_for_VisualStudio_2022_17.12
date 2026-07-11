using System;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class HealthHostRpcAdapter : IHostRpcAdapter
    {
        public bool CanHandle(string method)
        {
            return method == "host.health";
        }

        public Task<JToken?> HandleAsync(string method, JToken? parameters)
        {
            if (!CanHandle(method))
                throw new InvalidOperationException("Unsupported health host method: " + method);

            return Task.FromResult<JToken?>(new JObject
            {
                ["status"] = "ok",
                ["host"] = "visualstudio-vsix",
                ["received"] = parameters == null ? null : parameters.DeepClone()
            });
        }
    }
}
