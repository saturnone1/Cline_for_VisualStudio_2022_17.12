using System;
using System.IO;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class FileSystemHostRpcAdapter : IHostRpcAdapter
    {
        public bool CanHandle(string method)
        {
            switch (method)
            {
                case "host.fs.fileExists":
                case "workspace.fileExists":
                case "host.fs.readTextFile":
                case "workspace.readTextFile":
                case "workspace.writeTextFile":
                case "workspace.deleteFile":
                case "workspace.createDirectory":
                    return true;
                default:
                    return false;
            }
        }

        public Task<JToken?> HandleAsync(string method, JToken? parameters)
        {
            JToken result;
            switch (method)
            {
                case "host.fs.fileExists":
                case "workspace.fileExists":
                    result = new JObject { ["exists"] = File.Exists(GetString(parameters, "path")) };
                    break;
                case "host.fs.readTextFile":
                case "workspace.readTextFile":
                    result = ReadTextFile(parameters);
                    break;
                case "workspace.writeTextFile":
                    result = WriteTextFile(parameters);
                    break;
                case "workspace.deleteFile":
                    result = DeleteFile(parameters);
                    break;
                case "workspace.createDirectory":
                    result = CreateDirectory(parameters);
                    break;
                default:
                    throw new InvalidOperationException("Unsupported filesystem host method: " + method);
            }

            return Task.FromResult<JToken?>(result);
        }

        private static JObject ReadTextFile(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                return new JObject { ["exists"] = false, ["content"] = "" };

            return new JObject { ["exists"] = true, ["content"] = File.ReadAllText(path) };
        }

        private static JObject WriteTextFile(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path))
                return new JObject { ["success"] = false };

            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            File.WriteAllText(path, GetString(parameters, "content"));
            return new JObject { ["success"] = true };
        }

        private static JObject DeleteFile(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                return new JObject { ["success"] = false };

            File.Delete(path);
            return new JObject { ["success"] = true };
        }

        private static JObject CreateDirectory(JToken? parameters)
        {
            var path = GetString(parameters, "path");
            if (string.IsNullOrWhiteSpace(path))
                return new JObject { ["success"] = false };

            Directory.CreateDirectory(path);
            return new JObject { ["success"] = true };
        }

        private static string GetString(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<string>(name) ?? "" : "";
        }
    }
}
