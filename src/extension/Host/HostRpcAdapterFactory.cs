using System;
using System.Threading.Tasks;
using VsClineAgent.Host.Adapters;
using VsClineAgent.Services;

namespace VsClineAgent.Host
{
    internal static class HostRpcAdapterFactory
    {
        public static HostRpcRouter Create(
            string assemblyDirectory,
            VsEditorService editorService,
            VsCommandExecutionService commandExecutionService,
            Action<string, string?> captureSidecarLine,
            Func<Func<object, Task>?> postToWebview)
        {
            return new HostRpcRouter(new IHostRpcAdapter[]
            {
                new HealthHostRpcAdapter(),
                new EnvironmentHostRpcAdapter(captureSidecarLine),
                new EditorHostRpcAdapter(editorService),
                new FileSystemHostRpcAdapter(),
                new TerminalHostRpcAdapter(assemblyDirectory, editorService, commandExecutionService),
                new DiffHostRpcAdapter(editorService),
                new WorkspaceHostRpcAdapter(editorService),
                new WebviewHostRpcAdapter(postToWebview)
            });
        }
    }
}
