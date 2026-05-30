using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using VsClineAgent.Agent.AssistantMessage;
using VsClineAgent.Agent.Models;
using VsClineAgent.Agent.Prompts;
using VsClineAgent.Agent.Tools;
using VsClineAgent.Services;

namespace VsClineAgent.Agent
{
    // Represents the full agent runtime state for checkpointing and restore.
    public class TaskState
    {
        public List<ChatMessage> ApiHistory { get; set; } = new List<ChatMessage>();
        public string TaskText { get; set; } = string.Empty;
        public bool TaskCompleted { get; set; }
        public int ConsecutiveMistakeCount { get; set; }
    }

    // Port of Task class from /apps/vscode/src/core/task/index.ts
    // Handles the agent loop: startTask → recursivelyMakeClineRequests → parse XML → execute tools → loop
    internal class AgentController : IToolCallbacks
    {
        private readonly LlmClient _llm;
        private readonly ToolRegistry _tools;
        private readonly SettingsService _settings;
        private readonly VsEditorService _editorService;
        private readonly VsCommandExecutionService _commandService;

        // Conversation history — mirrors apiConversationHistory in Cline
        private readonly List<ChatMessage> _apiHistory = new List<ChatMessage>();

        private string _taskText = string.Empty;

        private CancellationTokenSource _cts;
        private string _cwd;
        private int _consecutiveMistakeCount = 0;
        private const int MaxConsecutiveMistakes = 3;
        private bool _taskCompleted = false;
        private string _completionResult = "";

        // Pending user input for ask_followup_question
        private TaskCompletionSource<string> _pendingUserInput;

        // Pending approval
        private TaskCompletionSource<bool> _pendingApproval;

        // Current executing tool (used to populate approval events with call ID + params)
        private AssistantMessage.ToolUse _currentToolBlock;

        public event EventHandler<AgentEvent> AgentEvent;

        public AgentController(SettingsService settings, VsEditorService editorService)
        {
            _settings = settings;
            _editorService = editorService;
            _commandService = new VsCommandExecutionService();
            _llm = new LlmClient();

            // Register all Cline tools
            _tools = new ToolRegistry();
            _tools.Register(new ReadFileTool());
            _tools.Register(new WriteFileTool());
            _tools.Register(new ReplaceInFileTool());
            _tools.Register(new ListFilesTool());
            _tools.Register(new SearchFilesTool());
            _tools.Register(new ExecuteCommandTool(_commandService));
            _tools.Register(new ListCodeDefinitionsTool());
            _tools.Register(new AskFollowupQuestionTool());
            _tools.Register(new AttemptCompletionTool());
        }

        public void UpdateSettings()
        {
            _llm.Configure(_settings.Load());
        }

        public List<ChatMessage> GetApiHistorySnapshot()
        {
            return _apiHistory
                .Where(message => message != null && !string.IsNullOrWhiteSpace(message.Role) && !string.IsNullOrWhiteSpace(message.Content))
                .Select(message => new ChatMessage
                {
                    Role = message.Role,
                    Content = message.Content
                })
                .ToList();
        }

        // Returns a snapshot of the full agent state for checkpointing
        public TaskState GetTaskStateSnapshot()
        {
            return new TaskState
            {
                ApiHistory = GetApiHistorySnapshot(),
                TaskText = _taskText,
                TaskCompleted = _taskCompleted,
                ConsecutiveMistakeCount = _consecutiveMistakeCount
            };
        }

        // Restores the agent state from a checkpoint
        public void RestoreTaskState(TaskState state)
        {
            _apiHistory.Clear();
            if (state?.ApiHistory != null)
                _apiHistory.AddRange(state.ApiHistory);
            _taskText = state?.TaskText ?? string.Empty;
            _taskCompleted = state?.TaskCompleted ?? false;
            _consecutiveMistakeCount = state?.ConsecutiveMistakeCount ?? 0;
        }

        public void Stop()
        {
            _cts?.Cancel();
            _pendingApproval?.TrySetResult(false);
            _pendingUserInput?.TrySetResult("");
        }

        // Called from UI when user approves or denies a tool
        public void SetApproval(bool approved)
        {
            _pendingApproval?.TrySetResult(approved);
        }

        // Called from UI when user answers a follow-up question
        public void SetUserInput(string text)
        {
            _pendingUserInput?.TrySetResult(text);
        }

        // Entry point — port of Task.startTask()
        public async Task StartTaskAsync(string task, string workspacePath)
        {
            _taskText = task;
            await StartTaskInternalAsync(task, workspacePath, resumeHistory: null);
        }

        public async Task ResumeTaskAsync(string task, string workspacePath, IEnumerable<ChatMessage>? resumeHistory)
        {
            _taskText = task;
            await StartTaskInternalAsync(task, workspacePath, resumeHistory);
        }

        private async Task StartTaskInternalAsync(string task, string workspacePath, IEnumerable<ChatMessage>? resumeHistory)
        {
            var cfg = _settings.Load();
            _llm.Configure(cfg);
            _cwd = string.IsNullOrEmpty(workspacePath) ? Directory.GetCurrentDirectory() : workspacePath;

            _cts = new CancellationTokenSource();
            _apiHistory.Clear();
            if (resumeHistory != null)
            {
                _apiHistory.AddRange(resumeHistory
                    .Where(message => message != null && !string.IsNullOrWhiteSpace(message.Role) && !string.IsNullOrWhiteSpace(message.Content))
                    .Select(message => new ChatMessage
                    {
                        Role = message.Role,
                        Content = message.Content
                    }));
            }
            _consecutiveMistakeCount = 0;
            _taskCompleted = false;

            Emit(AgentEvents.UserMessage(task));
            Emit(AgentEvents.Status("thinking"));

            // Build initial user content — port of startTask userContent construction
            // Wraps task in <task> tags exactly as Cline does
            string fileTreeSummary = BuildFileTree(_cwd, recursive: false);
            var activeCommands = await _commandService.GetActiveCommandsAsync();
            string envDetails = SystemPrompt.BuildEnvironmentDetails(_cwd, fileTreeSummary, activeCommands);
            string userText = $"<task>\n{task}\n</task>\n\n{envDetails}";

            await RecursivelyMakeRequestsAsync(
                new List<string> { userText },
                _cts.Token);
        }

        // Port of recursivelyMakeClineRequests()
        // userMessages = list of text blocks to send as user turn
        private async Task RecursivelyMakeRequestsAsync(
            List<string> userMessages,
            CancellationToken ct,
            int depth = 0)
        {
            if (ct.IsCancellationRequested || _taskCompleted) return;
            if (depth > 50) { Emit(AgentEvents.Error("Max recursion depth reached")); return; }

            // Handle consecutive mistake limit (port of maxConsecutiveMistakes check)
            if (_consecutiveMistakeCount >= MaxConsecutiveMistakes)
            {
                Emit(AgentEvents.Error(
                    $"Too many consecutive mistakes ({_consecutiveMistakeCount}). " +
                    "The model may need guidance. Please provide feedback."));
                // In VS 2022, ask user for feedback via follow-up
                string feedback = await AskUserAsync(
                    "Cline is having trouble proceeding. What should I do next?",
                    Array.Empty<string>(), ct);
                if (!string.IsNullOrEmpty(feedback))
                {
                    userMessages = new List<string>
                    {
                        FormatResponse.TooManyMistakes(feedback)
                    };
                }
                _consecutiveMistakeCount = 0;
            }

            // Add user turn to history
            string userContent = string.Join("\n\n", userMessages);
            _apiHistory.Add(ChatMessage.User(userContent));

            // Build full message list for LLM
            string systemPromptText = BuildSystemPrompt();
            var messages = new List<ChatMessage>();
            messages.Add(ChatMessage.System(systemPromptText));
            messages.AddRange(_apiHistory);

            Emit(AgentEvents.Status("thinking"));

            string assistantText;
            try
            {
                assistantText = await _llm.ChatAsync(messages, ct);
            }
            catch (OperationCanceledException)
            {
                Emit(AgentEvents.Status("idle"));
                return;
            }
            catch (Exception ex)
            {
                Emit(AgentEvents.Error($"LLM error: {ex.Message}"));
                Emit(AgentEvents.Status("error"));
                return;
            }

            if (string.IsNullOrWhiteSpace(assistantText))
            {
                Emit(AgentEvents.Error("Empty response from LLM. Retrying..."));
                _consecutiveMistakeCount++;
                await RecursivelyMakeRequestsAsync(
                    new List<string> { "You did not provide a response. Please try again." },
                    ct, depth + 1);
                return;
            }

            // Add assistant turn to history
            _apiHistory.Add(ChatMessage.Assistant(assistantText));

            // Parse the assistant message for XML tool calls — port of parseAssistantMessageV2
            var blocks = AssistantMessageParser.Parse(assistantText);

            bool didToolUse = false;
            var toolResultMessages = new List<string>();

            foreach (var block in blocks)
            {
                if (ct.IsCancellationRequested || _taskCompleted) break;

                if (block is TextStreamContent textBlock)
                {
                    // Strip thinking tags — port of presentAssistantMessage text handling
                    string displayText = textBlock.Content
                        .Replace("<thinking>", "").Replace("</thinking>", "")
                        .Replace("<think>", "").Replace("</think>", "")
                        .Trim();

                    if (!string.IsNullOrEmpty(displayText))
                        Emit(AgentEvents.AssistantText(displayText));
                }
                else if (block is ToolUse toolBlock)
                {
                    didToolUse = true;
                    _currentToolBlock = toolBlock;
                    Emit(AgentEvents.ToolUseStarted(toolBlock.Name, toolBlock.Params, toolBlock.CallId));
                    Emit(AgentEvents.Status("running"));

                    // Execute the tool
                    string toolOutput = await _tools.ExecuteAsync(toolBlock, _cwd, this, ct);
                    _currentToolBlock = null;

                    // attempt_completion signals completion via callback — check flag
                    if (_taskCompleted) break;

                    // Format tool result for next user message — Cline wraps results in context
                    string toolResultText = FormatToolResult(toolBlock.Name, toolBlock.Params, toolOutput);
                    toolResultMessages.Add(toolResultText);

                    Emit(AgentEvents.ToolResult(toolBlock.Name, toolOutput, toolBlock.CallId));

                    // Reset mistake count on successful tool use
                    _consecutiveMistakeCount = 0;
                }
            }

            if (_taskCompleted) { Emit(AgentEvents.Status("idle")); return; }
            if (ct.IsCancellationRequested) { Emit(AgentEvents.Status("idle")); return; }

            if (!didToolUse)
            {
                // Port of noToolsUsed handling: push error and increment mistake count
                toolResultMessages.Add(FormatResponse.NoToolsUsed());
                _consecutiveMistakeCount++;
                Emit(AgentEvents.Error("No tool was used. Requesting tool use..."));
            }

            // Loop: recurse with tool results as next user turn
            await RecursivelyMakeRequestsAsync(toolResultMessages, ct, depth + 1);
        }

        // Format tool result for conversation — mirrors Cline's userMessageContent format
        private static string FormatToolResult(string toolName, Dictionary<string, string> p, string output)
        {
            // Cline sends tool result back in a text block describing what happened
            p.TryGetValue("path", out var path);
            p.TryGetValue("command", out var cmd);

            string contextHint = toolName switch
            {
                "read_file" => $"[read_file for '{path}']",
                "write_to_file" => $"[write_to_file for '{path}']",
                "replace_in_file" => $"[replace_in_file for '{path}']",
                "execute_command" => $"[execute_command for '{cmd}']",
                "list_files" => $"[list_files for '{path}']",
                "search_files" => $"[search_files for '{path}']",
                "list_code_definition_names" => $"[list_code_definition_names for '{path}']",
                "ask_followup_question" => "[ask_followup_question]",
                _ => $"[{toolName}]",
            };

            return $"{contextHint} Result:\n<result>\n{output}\n</result>";
        }

        // IToolCallbacks — VS 2022 wrapper for user approval (port of shouldAutoApproveTool / ask pattern)
        public async Task<bool> AskApprovalAsync(string description, ApprovalRequest request, CancellationToken ct)
        {
            if (ShouldAutoApprove(request)) return true;

            _pendingApproval = new TaskCompletionSource<bool>();

            Emit(AgentEvents.AwaitingApproval(
                _currentToolBlock?.CallId ?? "",
                _currentToolBlock?.Name ?? "",
                _currentToolBlock?.Params ?? new Dictionary<string, string>(),
                description));

            using var reg = ct.Register(() => _pendingApproval.TrySetResult(false));
            return await _pendingApproval.Task;
        }

        private bool ShouldAutoApprove(ApprovalRequest request)
        {
            var cfg = _settings.Load();
            var settings = cfg.AutoApprovalSettings;
            var actions = settings?.Actions;
            if (settings == null || actions == null || !settings.Enabled)
                return false;

            switch (request?.Action)
            {
                case ApprovalAction.ReadFiles:
                    return request.IsExternal ? actions.ReadFilesExternally : actions.ReadFiles;
                case ApprovalAction.EditFiles:
                    return request.IsExternal ? actions.EditFilesExternally : actions.EditFiles;
                case ApprovalAction.ExecuteCommand:
                    if (request.RequiresExplicitApproval)
                        return actions.ExecuteAllCommands;
                    return actions.ExecuteSafeCommands || actions.ExecuteAllCommands;
                case ApprovalAction.UseBrowser:
                    return actions.UseBrowser;
                case ApprovalAction.UseMcp:
                    return actions.UseMcp;
                default:
                    return false;
            }
        }

        // IToolCallbacks — post status to UI
        public void PostStatus(string message) => Emit(AgentEvents.Status(message));

        // IToolCallbacks — port of ask_followup_question interaction
        public async Task<string> AskUserAsync(string question, string[] options, CancellationToken ct)
        {
            _pendingUserInput = new TaskCompletionSource<string>();

            Emit(AgentEvents.AskUser(question, options));

            using var reg = ct.Register(() => _pendingUserInput.TrySetResult(""));
            return await _pendingUserInput.Task;
        }

        // IToolCallbacks — called by AttemptCompletionTool
        public void SignalCompletion(string result, string command)
        {
            _taskCompleted = true;
            _completionResult = result;
            Emit(AgentEvents.TaskCompleted(result, command));
        }

        // Build the system prompt — port of getSystemPrompt() call in attemptApiRequest()
        private string BuildSystemPrompt()
        {
            string osInfo = $"Operating System: Windows\nDefault Shell: cmd.exe\nVisual Studio: 2022 17.12\nCurrent Working Directory: {_cwd}";
            return SystemPrompt.Build(_cwd, osInfo);
        }

        // Utility: simple file tree for environment_details
        private static string BuildFileTree(string path, bool recursive)
        {
            var sb = new StringBuilder();
            try
            {
                var entries = Directory.GetFileSystemEntries(path);
                Array.Sort(entries);
                foreach (var entry in entries)
                {
                    bool isDir = Directory.Exists(entry);
                    string name = Path.GetFileName(entry);
                    if (name.StartsWith(".") || name == "bin" || name == "obj" || name == "node_modules")
                        continue;
                    sb.AppendLine(isDir ? name + "/" : name);
                }
            }
            catch { /* ignore inaccessible dirs */ }
            return sb.ToString();
        }

        private void Emit(AgentEvent e) => AgentEvent?.Invoke(this, e);
    }

    // Event system
    internal class AgentEvent : EventArgs
    {
        public string Type { get; set; } = "";
        public string Content { get; set; } = "";
        public string Status { get; set; } = "";
        public string ToolName { get; set; } = "";
        public string ToolCallId { get; set; } = "";
        public Dictionary<string, string> ToolParams { get; set; }
        public string[] Options { get; set; }
        public bool IsError { get; set; }

        public object ToWebPayload()
        {
            switch (Type)
            {
                case "userMessage":
                    return new { type = "userMessage", content = Content };
                case "assistantText":
                    // WebApp expects "assistantMessage"
                    return new { type = "assistantMessage", content = Content };
                case "agentStatus":
                    return new { type = "agentStatus", status = Status };
                case "toolUseStarted":
                {
                    var argsJson = JsonConvert.SerializeObject(
                        ToolParams ?? new Dictionary<string, string>());
                    // WebApp expects "toolUse"
                    return new { type = "toolUse", toolCallId = ToolCallId, toolName = ToolName, arguments = argsJson };
                }
                case "toolResult":
                    return new { type = "toolResult", toolCallId = ToolCallId, content = Content, isError = IsError };
                case "awaitingApproval":
                {
                    var argsJson = JsonConvert.SerializeObject(
                        ToolParams ?? new Dictionary<string, string>());
                    return new { type = "awaitingApproval", toolCallId = ToolCallId, toolName = ToolName, arguments = argsJson };
                }
                case "askUser":
                    return new { type = "askUser", question = Content, options = Options };
                case "taskCompleted":
                    return new { type = "taskCompleted", result = Content };
                case "error":
                    return new { type = "error", content = Content, isError = true };
                default:
                    return new { type = Type };
            }
        }
    }

    internal static class AgentEvents
    {
        public static AgentEvent UserMessage(string text) =>
            new AgentEvent { Type = "userMessage", Content = text };
        public static AgentEvent AssistantText(string text) =>
            new AgentEvent { Type = "assistantText", Content = text };
        public static AgentEvent Status(string status) =>
            new AgentEvent { Type = "agentStatus", Status = status };
        public static AgentEvent ToolUseStarted(string name, Dictionary<string, string> p, string callId) =>
            new AgentEvent { Type = "toolUseStarted", ToolName = name, ToolParams = p, ToolCallId = callId };
        public static AgentEvent ToolResult(string name, string output, string callId, bool isError = false) =>
            new AgentEvent { Type = "toolResult", ToolName = name, Content = output, ToolCallId = callId, IsError = isError };
        public static AgentEvent AwaitingApproval(string callId, string toolName, Dictionary<string, string> p, string description) =>
            new AgentEvent { Type = "awaitingApproval", ToolCallId = callId, ToolName = toolName, ToolParams = p, Content = description };
        public static AgentEvent AskUser(string question, string[] options) =>
            new AgentEvent { Type = "askUser", Content = question, Options = options };
        public static AgentEvent TaskCompleted(string result, string cmd) =>
            new AgentEvent { Type = "taskCompleted", Content = result, Status = cmd };
        public static AgentEvent Error(string msg) =>
            new AgentEvent { Type = "error", Content = msg, IsError = true };
    }
}
