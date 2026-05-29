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
                var taskList = Package.GetGlobalService(typeof(SVsTaskList)) as IVsTaskList;
                if (taskList == null) return result;

                taskList.EnumTaskItems(out var enumItems);
                if (enumItems == null) return result;

                var items = new IVsTaskItem[1];
                while (true)
                {
                    enumItems.Next(1, items, out uint fetched);
                    if (fetched == 0) break;
                    var item = items[0];
                    try
                    {
                        item.get_Text(out var text);
                        item.get_Document(out var doc);
                        item.get_Line(out var line);
                        item.get_Priority(out var priority);
                        result.Add(new DiagnosticItem
                        {
                            Message = text ?? "",
                            File = doc ?? "",
                            Line = line + 1,
                            Severity = priority == VSTASKPRIORITY.TP_HIGH ? "Error"
                                     : priority == VSTASKPRIORITY.TP_NORMAL ? "Warning" : "Info"
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
