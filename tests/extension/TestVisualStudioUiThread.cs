using System;
using System.Threading.Tasks;

namespace VsClineAgent.Host
{
    internal static class VisualStudioUiThread
    {
        public static Task PostAsync(Action action)
        {
            action();
            return Task.CompletedTask;
        }

        public static T Invoke<T>(Func<T> action) => action();
    }
}
