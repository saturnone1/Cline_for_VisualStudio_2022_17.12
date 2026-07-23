using System;
using System.IO;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Host.Adapters;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class FileSystemHostRpcAdapterTests
    {
        [Fact]
        public async Task ReadTextFileRejectsFilesBeyondConfiguredLimit()
        {
            var directory = CreateTemporaryDirectory();
            try
            {
                var filePath = Path.Combine(directory, "large.txt");
                File.WriteAllText(filePath, new string('x', 64));
                var adapter = new FileSystemHostRpcAdapter(32, 100, 1000);

                var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    adapter.HandleAsync("workspace.readTextFile", new JObject { ["path"] = filePath }));

                Assert.Contains("too large", error.Message);
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        [Fact]
        public async Task RecursiveSearchDoesNotDescendIntoExcludedDirectories()
        {
            var directory = CreateTemporaryDirectory();
            try
            {
                var sourceDirectory = Directory.CreateDirectory(Path.Combine(directory, "src")).FullName;
                var excludedDirectory = Directory.CreateDirectory(Path.Combine(directory, "node_modules", "package")).FullName;
                File.WriteAllText(Path.Combine(sourceDirectory, "match.txt"), "needle");
                File.WriteAllText(Path.Combine(excludedDirectory, "hidden.txt"), "needle");
                var adapter = new FileSystemHostRpcAdapter(1024, 100, 1000);

                var result = (JObject)(await adapter.HandleAsync("workspace.searchFiles", new JObject
                {
                    ["path"] = directory,
                    ["query"] = "needle",
                    ["limit"] = 10
                }))!;

                var matches = (JArray)result["matches"]!;
                Assert.Single(matches);
                Assert.Contains(Path.Combine("src", "match.txt"), matches[0]!.Value<string>());
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        [Fact]
        public async Task RecursiveSearchStopsAtConfiguredScanBudget()
        {
            var directory = CreateTemporaryDirectory();
            try
            {
                for (var index = 0; index < 20; index++)
                    File.WriteAllText(Path.Combine(directory, $"file-{index}.txt"), "content");
                var adapter = new FileSystemHostRpcAdapter(1024, 3, 1000);

                var result = (JObject)(await adapter.HandleAsync("workspace.searchFiles", new JObject
                {
                    ["path"] = directory,
                    ["query"] = "missing",
                    ["limit"] = 10
                }))!;

                Assert.True(result.Value<bool>("truncated"));
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        private static string CreateTemporaryDirectory()
        {
            var path = Path.Combine(Path.GetTempPath(), "vscline-fs-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            return path;
        }
    }
}
