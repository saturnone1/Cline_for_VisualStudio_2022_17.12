using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace VsClineAgent.ToolWindows
{
    [Guid(PackageGuids.ChatToolWindowGuidString)]
    public class ChatToolWindow : ToolWindowPane
    {
        public ChatToolWindow() : base(null)
        {
            Caption = "LIG VS";
            Content = new ChatToolWindowControl();
        }

        public ChatToolWindowControl? Control => Content as ChatToolWindowControl;

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                Control?.Dispose();

            base.Dispose(disposing);
        }
    }
}
