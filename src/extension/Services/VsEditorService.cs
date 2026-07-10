using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace VsClineAgent.Services
{
    internal class VsEditorService
    {
        public async Task<string?> GetActiveFilePathAsync()
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                return GetDte()?.ActiveDocument?.FullName;
            }
            catch { return null; }
        }

        public async Task<string?> GetSolutionRootAsync()
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var solutionPath = GetDte()?.Solution?.FullName;
                return string.IsNullOrEmpty(solutionPath)
                    ? null
                    : System.IO.Path.GetDirectoryName(solutionPath);
            }
            catch { return null; }
        }

        public async Task OpenSolutionAsync(string solutionPath)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (string.IsNullOrWhiteSpace(solutionPath))
                throw new ArgumentException("Solution path is required.", nameof(solutionPath));

            var dte = GetDte();
            if (dte == null)
                throw new InvalidOperationException("Visual Studio automation object is unavailable.");

            dte.Solution.Open(solutionPath);
        }

        public async Task<List<string>> GetOpenDocumentsAsync()
        {
            var result = new List<string>();
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var dte = GetDte();
                if (dte?.Documents == null) return result;
                foreach (Document doc in dte.Documents)
                {
                    try { result.Add(doc.FullName); } catch { }
                }
            }
            catch { }
            return result;
        }

        public async Task OpenFileAsync(string filePath, int? lineNumber = null)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var dte = GetDte();
                if (dte == null) return;
                dte.ItemOperations.OpenFile(filePath);
                if (lineNumber.HasValue && dte.ActiveDocument?.Object("TextDocument") is TextDocument doc)
                {
                    var pt = doc.StartPoint.CreateEditPoint();
                    pt.MoveToLineAndOffset(lineNumber.Value, 1);
                    doc.Selection.MoveToPoint(pt);
                }
            }
            catch { }
        }

        public async Task<bool> SaveDocumentIfDirtyAsync(string filePath)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var dte = GetDte();
                if (dte?.Documents == null) return false;

                foreach (Document doc in dte.Documents)
                {
                    try
                    {
                        if (!string.Equals(doc.FullName, filePath, StringComparison.OrdinalIgnoreCase))
                            continue;

                        if (!doc.Saved)
                            doc.Save();

                        return true;
                    }
                    catch { }
                }
            }
            catch { }

            return false;
        }

        public async Task ExecuteCommandAsync(string commandName, string? arguments = null)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var dte = GetDte();
                if (dte == null)
                    return;

                if (string.IsNullOrWhiteSpace(arguments))
                    dte.ExecuteCommand(commandName);
                else
                    dte.ExecuteCommand(commandName, arguments);
            }
            catch { }
        }

        public async Task ReloadFileAsync(string filePath)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var dte = GetDte();
                if (dte?.Documents == null) return;
                foreach (Document doc in dte.Documents)
                {
                    try
                    {
                        if (string.Equals(doc.FullName, filePath, StringComparison.OrdinalIgnoreCase))
                        {
                            doc.Activate();
                            break;
                        }
                    }
                    catch { }
                }
            }
            catch { }
        }

        public async Task<List<DiagnosticItem>> GetDiagnosticsAsync()
        {
            var result = new List<DiagnosticItem>();
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var dte = GetDte();
                if (dte == null) return result;
                var errorItems = dte.ToolWindows.ErrorList.ErrorItems;
                for (int i = 1; i <= errorItems.Count; i++)
                {
                    try
                    {
                        var item = errorItems.Item(i);
                        result.Add(new DiagnosticItem
                        {
                            Message = item.Description ?? "",
                            File = item.FileName ?? "",
                            Line = item.Line,
                            Severity = item.ErrorLevel == EnvDTE80.vsBuildErrorLevel.vsBuildErrorLevelHigh ? "Error"
                                     : item.ErrorLevel == EnvDTE80.vsBuildErrorLevel.vsBuildErrorLevelMedium ? "Warning"
                                     : "Info"
                        });
                    }
                    catch { }
                }
            }
            catch { }
            return result;
        }

        public async Task SetStatusBarAsync(string message)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var bar = Package.GetGlobalService(typeof(SVsStatusbar)) as IVsStatusbar;
                bar?.SetText(message);
            }
            catch { }
        }

        private static DTE2? GetDte()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            return Package.GetGlobalService(typeof(SDTE)) as DTE2;
        }
    }

    internal class DiagnosticItem
    {
        public string Message { get; set; } = "";
        public string File { get; set; } = "";
        public int Line { get; set; }
        public string Severity { get; set; } = "";
    }
}
