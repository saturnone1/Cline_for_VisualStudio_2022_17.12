using System;
using System.Threading;

namespace VsClineAgent.Host
{
    internal sealed class ToolWindowLifetime : IDisposable
    {
        private readonly Action[] _disposeActions;
        private int _disposed;

        public ToolWindowLifetime(params Action[] disposeActions)
        {
            _disposeActions = disposeActions ?? Array.Empty<Action>();
        }

        public bool IsDisposed => Volatile.Read(ref _disposed) != 0;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;

            foreach (var action in _disposeActions)
            {
                try { action?.Invoke(); }
                catch { }
            }
        }
    }
}
