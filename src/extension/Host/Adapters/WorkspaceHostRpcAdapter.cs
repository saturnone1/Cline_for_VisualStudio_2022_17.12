using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Services;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class WorkspaceHostRpcAdapter : IHostRpcAdapter
    {
        private readonly VsEditorService _editorService;

        public WorkspaceHostRpcAdapter(VsEditorService editorService)
        {
            _editorService = editorService;
        }

        public bool CanHandle(string method)
        {
            switch (method)
            {
                case "host.workspace.getRoots":
                case "workspace.getRoots":
                case "workspace.getWorkspacePaths":
                case "workspace.getDiagnostics":
                case "workspace.openSolution":
                case "workspace.openFolder":
                    return true;
                default:
                    return false;
            }
        }

        public async Task<JToken?> HandleAsync(string method, JToken? parameters)
        {
            switch (method)
            {
                case "host.workspace.getRoots":
                case "workspace.getRoots":
                    return await GetRootsAsync().ConfigureAwait(false);
                case "workspace.getWorkspacePaths":
                    return await GetPathsAsync().ConfigureAwait(false);
                case "workspace.getDiagnostics":
                    return await GetDiagnosticsAsync().ConfigureAwait(false);
                case "workspace.openSolution":
                    return await OpenSolutionAsync(parameters).ConfigureAwait(false);
                case "workspace.openFolder":
                    return await OpenFolderAsync(parameters).ConfigureAwait(false);
                default:
                    throw new InvalidOperationException("Unsupported workspace host method: " + method);
            }
        }

        private async Task<JArray> GetRootsAsync()
        {
            var root = await _editorService.GetSolutionRootAsync().ConfigureAwait(false);
            return string.IsNullOrWhiteSpace(root)
                ? new JArray()
                : new JArray(new JObject { ["path"] = root, ["name"] = Path.GetFileName(root) });
        }

        private async Task<JArray> GetPathsAsync()
        {
            var root = await _editorService.GetSolutionRootAsync().ConfigureAwait(false);
            return string.IsNullOrWhiteSpace(root) ? new JArray() : new JArray(root!);
        }

        private async Task<JObject> GetDiagnosticsAsync()
        {
            var diagnostics = await _editorService.GetDiagnosticsAsync().ConfigureAwait(false);
            var fileDiagnostics = new JArray(diagnostics.GroupBy(item => item.File ?? "").Select(group =>
                new JObject
                {
                    ["filePath"] = group.Key,
                    ["diagnostics"] = new JArray(group.Select(diagnostic => new JObject
                    {
                        ["message"] = diagnostic.Message,
                        ["line"] = diagnostic.Line,
                        ["severity"] = diagnostic.Severity
                    }))
                }));
            return new JObject { ["fileDiagnostics"] = fileDiagnostics };
        }

        private async Task<JObject> OpenSolutionAsync(JToken? parameters)
        {
            var solutionPath = GetString(parameters, "solutionPath");
            var newWindow = GetBool(parameters, "newWindow");
            if (string.IsNullOrWhiteSpace(solutionPath) || !File.Exists(solutionPath))
                return Failure("Solution file was not found.", "solutionPath", solutionPath);

            try
            {
                if (newWindow)
                    StartVisualStudio(solutionPath);
                else
                    await _editorService.OpenSolutionAsync(solutionPath).ConfigureAwait(false);

                return new JObject { ["success"] = true, ["solutionPath"] = solutionPath, ["newWindow"] = newWindow };
            }
            catch (Exception ex)
            {
                return new JObject
                {
                    ["success"] = false, ["message"] = ex.Message,
                    ["solutionPath"] = solutionPath, ["newWindow"] = newWindow
                };
            }
        }

        private async Task<JObject> OpenFolderAsync(JToken? parameters)
        {
            var folderPath = GetString(parameters, "folderPath");
            if (string.IsNullOrWhiteSpace(folderPath))
                folderPath = GetString(parameters, "path");
            var newWindow = GetBool(parameters, "newWindow");
            if (string.IsNullOrWhiteSpace(folderPath) || !Directory.Exists(folderPath))
                return Failure("Folder was not found.", "folderPath", folderPath);

            try
            {
                if (newWindow)
                    StartVisualStudio(folderPath);
                else
                    await _editorService.ExecuteCommandAsync("File.OpenFolder", QuoteArgument(folderPath)).ConfigureAwait(false);

                return new JObject
                {
                    ["success"] = true, ["folderPath"] = folderPath,
                    ["newWindow"] = newWindow, ["folderOnly"] = true
                };
            }
            catch (Exception ex)
            {
                return new JObject
                {
                    ["success"] = false, ["message"] = ex.Message, ["folderPath"] = folderPath,
                    ["newWindow"] = newWindow, ["folderOnly"] = true
                };
            }
        }

        private static JObject Failure(string message, string pathField, string path)
        {
            return new JObject { ["success"] = false, ["message"] = message, [pathField] = path };
        }

        private static void StartVisualStudio(string path)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "devenv.exe",
                Arguments = QuoteArgument(path),
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Normal
            });
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
        }

        private static string GetString(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<string>(name) ?? "" : "";
        }

        private static bool GetBool(JToken? parameters, string name)
        {
            return parameters is JObject values && values.Value<bool?>(name) == true;
        }
    }
}
