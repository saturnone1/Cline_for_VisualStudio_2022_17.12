using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using VsClineAgent.Host;

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
            catch (Exception ex) { LogFailure("editor.activeFile.failed", ex); return null; }
        }

        public async Task<string?> GetSolutionRootAsync()
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var solutionPath = GetDte()?.Solution?.FullName;
                if (!string.IsNullOrWhiteSpace(solutionPath))
                    return System.IO.Path.GetDirectoryName(solutionPath);

                var solution = Package.GetGlobalService(typeof(SVsSolution)) as IVsSolution;
                if (solution != null && ErrorHandler.Succeeded(solution.GetSolutionInfo(out var solutionDirectory, out var solutionFile, out _)))
                {
                    if (!string.IsNullOrWhiteSpace(solutionDirectory))
                        return System.IO.Path.GetFullPath(solutionDirectory);
                    if (!string.IsNullOrWhiteSpace(solutionFile))
                        return System.IO.Path.GetDirectoryName(solutionFile);
                }

                var activeFile = GetDte()?.ActiveDocument?.FullName;
                return string.IsNullOrWhiteSpace(activeFile)
                    ? null
                    : System.IO.Path.GetDirectoryName(activeFile);
            }
            catch (Exception ex) { LogFailure("editor.solutionRoot.failed", ex); return null; }
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
                    try { result.Add(doc.FullName); }
                    catch (Exception ex) { LogFailure("editor.openDocumentEntry.failed", ex); }
                }
            }
            catch (Exception ex) { LogFailure("editor.openDocuments.failed", ex); }
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
            catch (Exception ex) { LogFailure("editor.openFile.failed", ex, filePath); }
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
                    catch (Exception ex) { LogFailure("editor.saveDocumentEntry.failed", ex, filePath); }
                }
            }
            catch (Exception ex) { LogFailure("editor.saveDocument.failed", ex, filePath); }

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
            catch (Exception ex) { LogFailure("editor.executeCommand.failed", ex, commandName); }
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
                    catch (Exception ex) { LogFailure("editor.reloadFileEntry.failed", ex, filePath); }
                }
            }
            catch (Exception ex) { LogFailure("editor.reloadFile.failed", ex, filePath); }
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
                    catch (Exception ex) { LogFailure("editor.diagnosticEntry.failed", ex, i.ToString()); }
                }
            }
            catch (Exception ex) { LogFailure("editor.diagnostics.failed", ex); }
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
            catch (Exception ex) { LogFailure("editor.statusBar.failed", ex); }
        }

        private static DTE2? GetDte()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            return Package.GetGlobalService(typeof(SDTE)) as DTE2;
        }

        private static void LogFailure(string eventName, Exception exception, string? target = null)
        {
            InteractionLog.Write("host", eventName, new
            {
                target,
                error = exception.Message,
                exceptionType = exception.GetType().FullName
            });
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
