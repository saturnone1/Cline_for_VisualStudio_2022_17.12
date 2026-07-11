using System;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using VsClineAgent.Services;

namespace VsClineAgent.Host.Adapters
{
    internal sealed class EditorHostRpcAdapter : IHostRpcAdapter
    {
        private readonly VsEditorService _editorService;

        public EditorHostRpcAdapter(VsEditorService editorService)
        {
            _editorService = editorService;
        }

        public bool CanHandle(string method)
        {
            switch (method)
            {
                case "host.editor.getOpenDocuments":
                case "workspace.getOpenDocuments":
                case "host.editor.getActiveFile":
                case "window.getActiveFile":
                case "window.showMessage":
                case "window.openFile":
                case "workspace.saveOpenDocumentIfDirty":
                case "workspace.openProblemsPanel":
                    return true;
                default:
                    return false;
            }
        }

        public async Task<JToken?> HandleAsync(string method, JToken? parameters)
        {
            switch (method)
            {
                case "host.editor.getOpenDocuments":
                case "workspace.getOpenDocuments":
                    return new JArray(await _editorService.GetOpenDocumentsAsync().ConfigureAwait(false));
                case "host.editor.getActiveFile":
                case "window.getActiveFile":
                    return new JObject
                    {
                        ["path"] = await _editorService.GetActiveFilePathAsync().ConfigureAwait(false)
                    };
                case "window.showMessage":
                    await _editorService.SetStatusBarAsync(GetString(parameters, "message")).ConfigureAwait(false);
                    return new JObject { ["shown"] = true };
                case "window.openFile":
                    await _editorService.OpenFileAsync(
                        GetString(parameters, "filePath"),
                        GetInt(parameters, "line")).ConfigureAwait(false);
                    return new JObject();
                case "workspace.saveOpenDocumentIfDirty":
                    return new JObject
                    {
                        ["saved"] = await _editorService.SaveDocumentIfDirtyAsync(
                            GetString(parameters, "filePath")).ConfigureAwait(false)
                    };
                case "workspace.openProblemsPanel":
                    await _editorService.ExecuteCommandAsync("View.ErrorList").ConfigureAwait(false);
                    return new JObject { ["success"] = true };
                default:
                    throw new InvalidOperationException("Unsupported editor host method: " + method);
            }
        }

        private static string GetString(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<string>(name) ?? "" : "";
        }

        private static int? GetInt(JToken? parameters, string name)
        {
            return parameters is JObject values ? values.Value<int?>(name) : null;
        }
    }
}
