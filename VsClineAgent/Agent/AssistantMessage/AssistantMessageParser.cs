using System;
using System.Collections.Generic;
using System.Linq;

namespace VsClineAgent.Agent.AssistantMessage
{
    // Port of parseAssistantMessageV2 from
    // /apps/vscode/src/core/assistant-message/parse-assistant-message.ts

    public static class AssistantMessageParser
    {
        private static int _callIdCounter = 0;
        private static string NewCallId() => (++_callIdCounter).ToString("x8");

        public static List<AssistantMessageContent> Parse(string assistantMessage)
        {
            var contentBlocks = new List<AssistantMessageContent>();

            int currentTextContentStart = 0;
            TextStreamContent currentTextContent = null;
            int currentToolUseStart = 0;
            ToolUse currentToolUse = null;
            int currentParamValueStart = 0;
            string currentParamName = null;

            // Precompute open tags — port of toolUseOpenTags and toolParamOpenTags Maps
            var toolUseOpenTags = new Dictionary<string, string>();
            foreach (var name in ClineToolNames.AllTools)
                toolUseOpenTags[$"<{name}>"] = name;

            var toolParamOpenTags = new Dictionary<string, string>();
            foreach (var name in ToolParamNames.All)
                toolParamOpenTags[$"<{name}>"] = name;

            int len = assistantMessage.Length;
            for (int i = 0; i < len; i++)
            {
                int ci = i;

                // --- State: Parsing a Tool Parameter ---
                if (currentToolUse != null && currentParamName != null)
                {
                    string closeTag = $"</{currentParamName}>";
                    if (ci >= closeTag.Length - 1 &&
                        assistantMessage.IndexOf(closeTag, ci - closeTag.Length + 1, StringComparison.Ordinal) == ci - closeTag.Length + 1)
                    {
                        string value = assistantMessage
                            .Substring(currentParamValueStart, (ci - closeTag.Length + 1) - currentParamValueStart)
                            .Trim();
                        currentToolUse.Params[currentParamName] = value;
                        currentParamName = null;
                        // fall through to check for tool close or next param at index ci
                    }
                    else
                    {
                        continue;
                    }
                }

                // --- State: Parsing a Tool Use (not inside a specific parameter) ---
                if (currentToolUse != null && currentParamName == null)
                {
                    bool startedNewParam = false;
                    foreach (var kv in toolParamOpenTags)
                    {
                        string tag = kv.Key;
                        string paramName = kv.Value;
                        if (ci >= tag.Length - 1 &&
                            assistantMessage.IndexOf(tag, ci - tag.Length + 1, StringComparison.Ordinal) == ci - tag.Length + 1)
                        {
                            currentParamName = paramName;
                            currentParamValueStart = ci + 1;
                            startedNewParam = true;
                            break;
                        }
                    }
                    if (startedNewParam) continue;

                    string toolCloseTag = $"</{currentToolUse.Name}>";
                    if (ci >= toolCloseTag.Length - 1 &&
                        assistantMessage.IndexOf(toolCloseTag, ci - toolCloseTag.Length + 1, StringComparison.Ordinal) == ci - toolCloseTag.Length + 1)
                    {
                        // Special handling for write_to_file <content> (mirrors the V2 logic)
                        if (currentToolUse.Name == ClineToolNames.FILE_NEW)
                        {
                            string toolSlice = assistantMessage.Substring(
                                currentToolUseStart,
                                (ci - toolCloseTag.Length + 1) - currentToolUseStart);
                            const string contentOpen = "<content>";
                            const string contentClose = "</content>";
                            int cs = toolSlice.IndexOf(contentOpen, StringComparison.Ordinal);
                            int ce = toolSlice.LastIndexOf(contentClose, StringComparison.Ordinal);
                            if (cs != -1 && ce != -1 && ce > cs)
                            {
                                string val = toolSlice
                                    .Substring(cs + contentOpen.Length, ce - (cs + contentOpen.Length))
                                    .Trim();
                                currentToolUse.Params["content"] = val;
                            }
                        }

                        currentToolUse.Partial = false;
                        contentBlocks.Add(currentToolUse);
                        currentToolUse = null;
                        currentTextContentStart = ci + 1;
                        continue;
                    }
                    continue;
                }

                // --- State: Parsing Text / Looking for Tool Start ---
                if (currentToolUse == null)
                {
                    bool startedNewTool = false;
                    foreach (var kv in toolUseOpenTags)
                    {
                        string tag = kv.Key;
                        string toolName = kv.Value;
                        if (ci >= tag.Length - 1 &&
                            assistantMessage.IndexOf(tag, ci - tag.Length + 1, StringComparison.Ordinal) == ci - tag.Length + 1)
                        {
                            // End current text block if active
                            if (currentTextContent != null)
                            {
                                currentTextContent.Content = assistantMessage
                                    .Substring(currentTextContentStart, (ci - tag.Length + 1) - currentTextContentStart)
                                    .Trim();
                                currentTextContent.Partial = false;
                                if (currentTextContent.Content.Length > 0)
                                    contentBlocks.Add(currentTextContent);
                                currentTextContent = null;
                            }
                            else
                            {
                                string potentialText = assistantMessage
                                    .Substring(currentTextContentStart, (ci - tag.Length + 1) - currentTextContentStart)
                                    .Trim();
                                if (potentialText.Length > 0)
                                    contentBlocks.Add(new TextStreamContent { Content = potentialText, Partial = false });
                            }

                            currentToolUse = new ToolUse
                            {
                                Name = toolName,
                                Params = new Dictionary<string, string>(),
                                Partial = true,
                                CallId = NewCallId(),
                            };
                            currentToolUseStart = ci + 1;
                            startedNewTool = true;
                            break;
                        }
                    }
                    if (startedNewTool) continue;

                    if (currentTextContent == null)
                    {
                        currentTextContentStart = ci;
                        currentTextContent = new TextStreamContent { Content = "", Partial = true };
                    }
                }
            } // end loop

            // --- Finalization ---
            if (currentToolUse != null && currentParamName != null)
            {
                currentToolUse.Params[currentParamName] = assistantMessage
                    .Substring(currentParamValueStart)
                    .Trim();
            }

            if (currentToolUse != null)
            {
                contentBlocks.Add(currentToolUse);
            }
            else if (currentTextContent != null)
            {
                currentTextContent.Content = assistantMessage
                    .Substring(currentTextContentStart)
                    .Trim();
                if (currentTextContent.Content.Length > 0)
                    contentBlocks.Add(currentTextContent);
            }

            return contentBlocks;
        }
    }
}
