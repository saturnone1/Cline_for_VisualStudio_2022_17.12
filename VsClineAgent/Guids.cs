using System;

namespace VsClineAgent
{
    internal static class PackageGuids
    {
        public const string PackageGuidString = "3F8C2A1D-E7B4-4F9E-A8C5-6D2B1F7E3A04";
        public static readonly Guid PackageGuid = new Guid(PackageGuidString);

        public const string CommandSetGuidString = "7A4E9F2B-1C8D-4B3E-9F7A-2E6C0D8B5A1F";
        public static readonly Guid CommandSetGuid = new Guid(CommandSetGuidString);

        public const string ChatToolWindowGuidString = "B9E4C7F3-2A1D-4E8B-9C6F-3B7A2E5D1C0E";
        public static readonly Guid ChatToolWindowGuid = new Guid(ChatToolWindowGuidString);
    }

    internal static class PackageCommandIds
    {
        public const int OpenChatWindow = 0x0100;
        public const int ClearChatHistory = 0x0101;
    }
}
