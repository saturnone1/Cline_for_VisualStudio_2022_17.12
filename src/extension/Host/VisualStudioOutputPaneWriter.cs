using System;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using VsClineAgent.Services;

namespace VsClineAgent.Host
{
    internal sealed class VisualStudioOutputPaneWriter : ICommandOutputWriter, ICommandOutputSurface
    {
        private static readonly Guid OutputPaneGuid = new Guid("A95D2F78-1D66-4E7D-B3B0-7E7193E129F1");
        private readonly object _paneLock = new object();
        private IVsOutputWindowPane? _pane;

        public async Task WriteLineAsync(string text)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var pane = GetOrCreatePane();
                pane?.OutputStringThreadSafe(text + Environment.NewLine);
            }
            catch
            {
            }
        }

        public async Task<bool> ShowAsync()
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var pane = GetOrCreatePane();
                if (pane == null)
                    return false;

                pane.Activate();
                return true;
            }
            catch
            {
                return false;
            }
        }

        private IVsOutputWindowPane? GetOrCreatePane()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            lock (_paneLock)
            {
                if (_pane != null)
                    return _pane;
            }

            var outputPaneGuid = OutputPaneGuid;
            var outputWindow = Package.GetGlobalService(typeof(SVsOutputWindow)) as IVsOutputWindow;
            if (outputWindow == null)
                return null;

            // Command output is diagnostic background activity. Creating or activating a
            // visible pane here steals focus from the LIG VS WebView during a task.
            outputWindow.CreatePane(ref outputPaneGuid, "LIG VS Command", 0, 1);
            outputWindow.GetPane(ref outputPaneGuid, out var pane);
            lock (_paneLock)
            {
                _pane = pane;
            }

            return pane;
        }
    }
}
