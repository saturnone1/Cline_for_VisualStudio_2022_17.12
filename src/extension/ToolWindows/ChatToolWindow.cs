using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio;

namespace VsClineAgent.ToolWindows
{
    [Guid(PackageGuids.ChatToolWindowGuidString)]
    public class ChatToolWindow : ToolWindowPane, IVsWindowFrameNotify3
    {
        public ChatToolWindow() : base(null)
        {
            Caption = "LIG VS";
            Content = new ChatToolWindowControl();
        }

        public ChatToolWindowControl? Control => Content as ChatToolWindowControl;

        public override void OnToolWindowCreated()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            base.OnToolWindowCreated();
            if (Frame is IVsWindowFrame frame)
                frame.SetProperty((int)__VSFPROPID.VSFPROPID_ViewHelper, this);
        }

        public int OnShow(int fShow)
        {
            if ((fShow == (int)__FRAMESHOW.FRAMESHOW_WinShown ||
                 fShow == (int)__FRAMESHOW.FRAMESHOW_TabActivated ||
                 fShow == (int)__FRAMESHOW.FRAMESHOW_WinRestored) &&
                (Control == null || Control.IsDisposed))
            {
                Content = new ChatToolWindowControl();
            }
            return VSConstants.S_OK;
        }

        public int OnClose(ref uint pgrfSaveOptions)
        {
            Control?.Dispose();
            return VSConstants.S_OK;
        }

        public int OnMove(int x, int y, int w, int h) => VSConstants.S_OK;
        public int OnSize(int x, int y, int w, int h) => VSConstants.S_OK;
        public int OnDockableChange(int fDockable, int x, int y, int w, int h) => VSConstants.S_OK;

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                Control?.Dispose();

            base.Dispose(disposing);
        }
    }
}
