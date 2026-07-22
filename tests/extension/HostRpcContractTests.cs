using System;
using System.IO;
using System.Linq;
using VsClineAgent.Host.Generated;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class HostRpcContractTests
    {
        [Fact]
        public void EveryCanonicalMethodIsHandledByTheExtensionAdapters()
        {
            var adapterDirectory = Path.Combine(FindRepositoryRoot(), "src", "extension", "Host", "Adapters");
            var source = string.Join("\n", Directory.GetFiles(adapterDirectory, "*.cs").Select(File.ReadAllText));

            foreach (var method in HostRpcContract.All)
                Assert.Contains("\"" + method + "\"", source, StringComparison.Ordinal);
        }

        private static string FindRepositoryRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                if (File.Exists(Path.Combine(current.FullName, "contracts", "host-rpc.json")))
                    return current.FullName;
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("Repository root was not found.");
        }
    }
}
