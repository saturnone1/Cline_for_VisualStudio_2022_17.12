using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Adapters;

namespace VsClineAgent.Host
{
    internal sealed class HostRpcRouter
    {
        private readonly IReadOnlyList<IHostRpcAdapter> _adapters;

        public HostRpcRouter(IReadOnlyList<IHostRpcAdapter> adapters)
        {
            _adapters = adapters;
        }

        public async Task<JToken?> HandleAsync(
            string method,
            JToken? parameters,
            System.Threading.CancellationToken cancellationToken = default(System.Threading.CancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            InteractionLog.Write("sidecar->host", method, parameters);
            foreach (var adapter in _adapters)
            {
                if (adapter.CanHandle(method))
                    return await adapter.HandleAsync(method, parameters, cancellationToken).ConfigureAwait(false);
            }

            throw new InvalidOperationException("Unsupported host method: " + method);
        }
    }
}
