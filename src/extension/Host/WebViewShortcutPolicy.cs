namespace VsClineAgent.Host
{
    internal static class WebViewShortcutPolicy
    {
        private const int VirtualKeyF5 = 0x74;

        public static bool TryResolveVisualStudioCommand(
            int virtualKey,
            bool control,
            bool shift,
            bool alt,
            out string command)
        {
            command = string.Empty;
            if (virtualKey != VirtualKeyF5 || alt || (control && shift))
                return false;

            command = shift
                ? "Debug.StopDebugging"
                : control
                    ? "Debug.StartWithoutDebugging"
                    : "Debug.Start";
            return true;
        }
    }
}
