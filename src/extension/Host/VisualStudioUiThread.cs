using System;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;

namespace VsClineAgent.Host
{
    internal static class VisualStudioUiThread
    {
        public static void Post(Action action)
        {
            if (action == null) throw new ArgumentNullException(nameof(action));
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                action();
            });
        }

        public static Task InvokeAsync(Action action)
        {
            if (action == null) throw new ArgumentNullException(nameof(action));
            return ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                action();
            }).Task;
        }

        public static T Invoke<T>(Func<T> action)
        {
            if (action == null) throw new ArgumentNullException(nameof(action));
            return ThreadHelper.JoinableTaskFactory.Run(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                return action();
            });
        }

        public static void Invoke(Action action)
        {
            if (action == null) throw new ArgumentNullException(nameof(action));
            ThreadHelper.JoinableTaskFactory.Run(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                action();
            });
        }
    }
}
