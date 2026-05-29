using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace VsClineAgent.Agent.AssistantMessage
{
    // Port of constructNewFileContentV1 from
    // /apps/vscode/src/core/assistant-message/diff.ts

    public static class DiffApplier
    {
        // Flexible marker patterns — port of the regex patterns in diff.ts
        private static readonly Regex SearchStartRegex = new Regex(@"^[-]{3,} SEARCH>?$", RegexOptions.Compiled);
        private static readonly Regex LegacySearchStartRegex = new Regex(@"^[<]{3,} SEARCH>?$", RegexOptions.Compiled);
        private static readonly Regex SearchEndRegex = new Regex(@"^[=]{3,}$", RegexOptions.Compiled);
        private static readonly Regex ReplaceEndRegex = new Regex(@"^[+]{3,} REPLACE>?$", RegexOptions.Compiled);
        private static readonly Regex LegacyReplaceEndRegex = new Regex(@"^[>]{3,} REPLACE>?$", RegexOptions.Compiled);

        private static bool IsSearchBlockStart(string line) =>
            SearchStartRegex.IsMatch(line) || LegacySearchStartRegex.IsMatch(line);

        private static bool IsSearchBlockEnd(string line) =>
            SearchEndRegex.IsMatch(line);

        private static bool IsReplaceBlockEnd(string line) =>
            ReplaceEndRegex.IsMatch(line) || LegacyReplaceEndRegex.IsMatch(line);

        // Returns the reconstructed file content after applying diff.
        // isFinal = true means this is the complete diff, not a streaming chunk.
        public static string Apply(string diffContent, string originalContent, bool isFinal = true)
        {
            string result = "";
            int lastProcessedIndex = 0;

            string currentSearchContent = "";
            string currentReplaceContent = "";
            bool inSearch = false;
            bool inReplace = false;

            int searchMatchIndex = -1;
            int searchEndIndex = -1;

            var replacements = new List<(int start, int end, string content)>();
            bool pendingOutOfOrderReplacement = false;

            var lines = new List<string>(diffContent.Split('\n'));

            // Remove potential partial marker at the end (mirrors the JS logic)
            if (lines.Count > 0)
            {
                string lastLine = lines[lines.Count - 1];
                if ((lastLine.StartsWith("-") || lastLine.StartsWith("<") ||
                     lastLine.StartsWith("=") || lastLine.StartsWith("+") ||
                     lastLine.StartsWith(">")) &&
                    !IsSearchBlockStart(lastLine) &&
                    !IsSearchBlockEnd(lastLine) &&
                    !IsReplaceBlockEnd(lastLine))
                {
                    lines.RemoveAt(lines.Count - 1);
                }
            }

            foreach (var line in lines)
            {
                if (IsSearchBlockStart(line))
                {
                    inSearch = true;
                    currentSearchContent = "";
                    currentReplaceContent = "";
                    continue;
                }

                if (IsSearchBlockEnd(line))
                {
                    inSearch = false;
                    inReplace = true;

                    if (string.IsNullOrEmpty(currentSearchContent))
                    {
                        if (originalContent.Length == 0)
                        {
                            searchMatchIndex = 0;
                            searchEndIndex = 0;
                        }
                        else
                        {
                            throw new Exception(
                                "Empty SEARCH block detected with non-empty file. " +
                                "Please ensure your SEARCH marker follows the correct format.");
                        }
                    }
                    else
                    {
                        int exactIdx = originalContent.IndexOf(currentSearchContent, lastProcessedIndex, StringComparison.Ordinal);
                        if (exactIdx != -1)
                        {
                            searchMatchIndex = exactIdx;
                            searchEndIndex = exactIdx + currentSearchContent.Length;
                        }
                        else
                        {
                            var lineMatch = LineTrimmedFallbackMatch(originalContent, currentSearchContent, lastProcessedIndex);
                            if (lineMatch.HasValue)
                            {
                                searchMatchIndex = lineMatch.Value.start;
                                searchEndIndex = lineMatch.Value.end;
                            }
                            else
                            {
                                var blockMatch = BlockAnchorFallbackMatch(originalContent, currentSearchContent, lastProcessedIndex);
                                if (blockMatch.HasValue)
                                {
                                    searchMatchIndex = blockMatch.Value.start;
                                    searchEndIndex = blockMatch.Value.end;
                                }
                                else
                                {
                                    // Last resort: full-file search from beginning
                                    int fullIdx = originalContent.IndexOf(currentSearchContent, 0, StringComparison.Ordinal);
                                    if (fullIdx != -1)
                                    {
                                        searchMatchIndex = fullIdx;
                                        searchEndIndex = fullIdx + currentSearchContent.Length;
                                        if (searchMatchIndex < lastProcessedIndex)
                                            pendingOutOfOrderReplacement = true;
                                    }
                                    else
                                    {
                                        throw new Exception(
                                            $"The SEARCH block:\n{currentSearchContent.TrimEnd()}\n...does not match anything in the file.");
                                    }
                                }
                            }
                        }
                    }

                    if (searchMatchIndex < lastProcessedIndex)
                        pendingOutOfOrderReplacement = true;

                    if (!pendingOutOfOrderReplacement)
                        result += originalContent.Substring(lastProcessedIndex, searchMatchIndex - lastProcessedIndex);

                    continue;
                }

                if (IsReplaceBlockEnd(line))
                {
                    if (searchMatchIndex == -1)
                        throw new Exception($"The SEARCH block:\n{currentSearchContent.TrimEnd()}\n...is malformatted.");

                    replacements.Add((searchMatchIndex, searchEndIndex, currentReplaceContent));

                    if (!pendingOutOfOrderReplacement)
                        lastProcessedIndex = searchEndIndex;

                    inSearch = false;
                    inReplace = false;
                    currentSearchContent = "";
                    currentReplaceContent = "";
                    searchMatchIndex = -1;
                    searchEndIndex = -1;
                    pendingOutOfOrderReplacement = false;
                    continue;
                }

                if (inSearch)
                {
                    currentSearchContent += line + "\n";
                }
                else if (inReplace)
                {
                    currentReplaceContent += line + "\n";
                    if (searchMatchIndex != -1 && !pendingOutOfOrderReplacement)
                        result += line + "\n";
                }
            }

            if (isFinal)
            {
                // Handle still-open replace block at end of final chunk
                if (inReplace && searchMatchIndex != -1)
                {
                    replacements.Add((searchMatchIndex, searchEndIndex, currentReplaceContent));
                    if (!pendingOutOfOrderReplacement)
                        lastProcessedIndex = searchEndIndex;
                }

                // Apply out-of-order replacements by rebuilding from scratch
                if (replacements.Count > 0)
                {
                    // Sort replacements by start index
                    replacements.Sort((a, b) => a.start.CompareTo(b.start));

                    string finalResult = "";
                    int pos = 0;

                    // Check if we had any in-order result already built
                    // Re-build entirely from sorted replacements for correctness
                    bool hasOutOfOrder = false;
                    for (int ri = 0; ri < replacements.Count - 1; ri++)
                    {
                        if (replacements[ri].end > replacements[ri + 1].start)
                        {
                            hasOutOfOrder = true;
                            break;
                        }
                    }

                    // For the simple case (all in-order), we already built result incrementally.
                    // Only need to append the tail.
                    bool allInOrder = !hasOutOfOrder;
                    bool outOfOrderDetected = replacements.Exists(r => r.start < 0); // sentinel

                    // Simplest safe approach: always rebuild from sorted replacements
                    finalResult = "";
                    pos = 0;
                    foreach (var (start, end, content) in replacements)
                    {
                        if (start > pos)
                            finalResult += originalContent.Substring(pos, start - pos);
                        finalResult += content;
                        pos = end;
                    }
                    // Append remaining original content after last replacement
                    if (pos < originalContent.Length)
                        finalResult += originalContent.Substring(pos);

                    return finalResult;
                }

                // No replacements tracked (pure insertion into empty file)
                result += originalContent.Substring(lastProcessedIndex);
                return result;
            }

            return result;
        }

        // Port of lineTrimmedFallbackMatch
        private static (int start, int end)? LineTrimmedFallbackMatch(
            string originalContent, string searchContent, int startIndex)
        {
            var originalLines = originalContent.Split('\n');
            var searchLines = new List<string>(searchContent.Split('\n'));

            if (searchLines.Count > 0 && searchLines[searchLines.Count - 1] == "")
                searchLines.RemoveAt(searchLines.Count - 1);

            // Find starting line number from startIndex
            int startLineNum = 0;
            int currentIdx = 0;
            while (currentIdx < startIndex && startLineNum < originalLines.Length)
            {
                currentIdx += originalLines[startLineNum].Length + 1;
                startLineNum++;
            }

            for (int i = startLineNum; i <= originalLines.Length - searchLines.Count; i++)
            {
                bool matches = true;
                for (int j = 0; j < searchLines.Count; j++)
                {
                    if (originalLines[i + j].Trim() != searchLines[j].Trim())
                    {
                        matches = false;
                        break;
                    }
                }

                if (matches)
                {
                    int matchStart = 0;
                    for (int k = 0; k < i; k++)
                        matchStart += originalLines[k].Length + 1;

                    int matchEnd = matchStart;
                    for (int k = 0; k < searchLines.Count; k++)
                        matchEnd += originalLines[i + k].Length + 1;

                    return (matchStart, matchEnd);
                }
            }
            return null;
        }

        // Port of blockAnchorFallbackMatch
        private static (int start, int end)? BlockAnchorFallbackMatch(
            string originalContent, string searchContent, int startIndex)
        {
            var originalLines = originalContent.Split('\n');
            var searchLines = new List<string>(searchContent.Split('\n'));

            if (searchLines.Count < 3) return null;

            if (searchLines[searchLines.Count - 1] == "")
                searchLines.RemoveAt(searchLines.Count - 1);

            string firstLine = searchLines[0].Trim();
            string lastLine = searchLines[searchLines.Count - 1].Trim();
            int blockSize = searchLines.Count;

            int startLineNum = 0;
            int currentIdx = 0;
            while (currentIdx < startIndex && startLineNum < originalLines.Length)
            {
                currentIdx += originalLines[startLineNum].Length + 1;
                startLineNum++;
            }

            for (int i = startLineNum; i <= originalLines.Length - blockSize; i++)
            {
                if (originalLines[i].Trim() != firstLine) continue;
                if (originalLines[i + blockSize - 1].Trim() != lastLine) continue;

                int matchStart = 0;
                for (int k = 0; k < i; k++)
                    matchStart += originalLines[k].Length + 1;

                int matchEnd = matchStart;
                for (int k = 0; k < blockSize; k++)
                    matchEnd += originalLines[i + k].Length + 1;

                return (matchStart, matchEnd);
            }
            return null;
        }
    }
}
