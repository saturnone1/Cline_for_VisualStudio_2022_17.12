using System;
using System.ComponentModel.Design;
using System.IO;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
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
                try
                {
                    await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);

                    var window = await _package.ShowToolWindowAsync(
                        typeof(ChatToolWindow), 0, true, _package.DisposalToken);

                    if (window?.Frame is IVsWindowFrame frame)
                    {
                        Microsoft.VisualStudio.ErrorHandler.ThrowOnFailure(frame.Show());
                        return;
                    }

                    throw new InvalidOperationException("LIG VS tool window frame was not created.");
                }
                catch (Exception ex)
                {
                    LogOpenFailure(ex);

                    await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                    VsShellUtilities.ShowMessageBox(
                        _package,
                        "LIG VS 창을 열지 못했습니다.\n\n" + ex.Message,
                        "LIG VS",
                        OLEMSGICON.OLEMSGICON_CRITICAL,
                        OLEMSGBUTTON.OLEMSGBUTTON_OK,
                        OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
                }
            });
        }

        private static void LogOpenFailure(Exception ex)
        {
            try
            {
                var logDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "VsClineAgent",
                    "Logs");
                Directory.CreateDirectory(logDirectory);

                var logPath = Path.Combine(logDirectory, "tool-window.log");
                File.AppendAllText(
                    logPath,
                    DateTimeOffset.Now.ToString("O") + " Failed to open LIG VS tool window" +
                    Environment.NewLine + ex + Environment.NewLine + Environment.NewLine);
            }
            catch
            {
                // Avoid hiding the original tool-window error behind logging failures.
            }
        }
    }
}
