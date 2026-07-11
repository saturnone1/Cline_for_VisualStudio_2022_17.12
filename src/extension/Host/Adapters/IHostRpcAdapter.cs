using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host.Adapters
{
    internal interface IHostRpcAdapter
    {
        bool CanHandle(string method);

        Task<JToken?> HandleAsync(string method, JToken? parameters);
    }
}
