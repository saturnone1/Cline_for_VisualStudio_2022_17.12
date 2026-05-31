using System;
using System.ComponentModel.Design;
using Microsoft.VisualStudio.Shell;
using VsClineAgent.ToolWindows;
using Task = System.Threading.Tasks.Task;

namespace VsClineAgent.Commands
{
    internal sealed class OpenChatWindowCommand
    {
        private readonly AsyncPackage _package;

        private OpenChatWindowCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package;
            var commandId = new CommandID(PackageGuids.CommandSetGuid, PackageCommandIds.OpenChatWindow);
            var command = new MenuCommand(Execute, commandId);
            commandService.AddCommand(command);
        }

        public static OpenChatWindowCommand? Instance { get; private set; }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            var commandService = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
            if (commandService != null)
                Instance = new OpenChatWindowCommand(package, commandService);
        }

        private void Execute(object sender, EventArgs e)
        {
            _ = _package.JoinableTaskFactory.RunAsync(async () =>
            {
                var window = await _package.ShowToolWindowAsync(
                    typeof(ChatToolWindow), 0, true, _package.DisposalToken);

                await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                if (window?.Frame is Microsoft.VisualStudio.Shell.Interop.IVsWindowFrame frame)
                {
                    Microsoft.VisualStudio.ErrorHandler.ThrowOnFailure(frame.Show());
                }
            });
        }
    }
}
