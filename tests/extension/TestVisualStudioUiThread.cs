using System;

namespace VsClineAgent.Host
{
    internal static class VisualStudioUiThread
    {
        public static T Invoke<T>(Func<T> action) => action();
    }
}
