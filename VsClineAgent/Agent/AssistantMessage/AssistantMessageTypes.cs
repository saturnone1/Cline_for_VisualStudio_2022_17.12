using System.Collections.Generic;

namespace VsClineAgent.Agent.AssistantMessage
{
    // Port of /apps/vscode/src/core/assistant-message/index.ts

    public abstract class AssistantMessageContent
    {
        public bool Partial { get; set; }
    }

    public class TextStreamContent : AssistantMessageContent
    {
        public string Content { get; set; } = "";
    }

    public class ToolUse : AssistantMessageContent
    {
        public string Name { get; set; } = "";
        public Dictionary<string, string> Params { get; set; } = new Dictionary<string, string>();
        public string CallId { get; set; } = "";
    }

    // Port of toolParamNames array from index.ts
    public static class ToolParamNames
    {
        public static readonly string[] All = new[]
        {
            "command", "requires_approval", "path", "absolutePath", "content", "diff",
            "regex", "file_pattern", "recursive", "action", "url", "coordinate", "text",
            "query", "allowed_domains", "blocked_domains", "prompt", "server_name",
            "tool_name", "arguments", "uri", "question", "options", "response", "result",
            "context", "title", "what_happened", "steps_to_reproduce", "api_request_output",
            "additional_context", "needs_more_exploration", "task_progress", "timeout",
            "input", "from_ref", "to_ref", "skill_name",
            "prompt_1", "prompt_2", "prompt_3", "prompt_4", "prompt_5",
            "start_line", "end_line",
        };
    }

    // Port of ClineDefaultTool enum from tools.ts
    public static class ClineToolNames
    {
        public const string ASK = "ask_followup_question";
        public const string ATTEMPT = "attempt_completion";
        public const string BASH = "execute_command";
        public const string FILE_EDIT = "replace_in_file";
        public const string FILE_READ = "read_file";
        public const string FILE_NEW = "write_to_file";
        public const string SEARCH = "search_files";
        public const string LIST_FILES = "list_files";
        public const string LIST_CODE_DEF = "list_code_definition_names";
        public const string BROWSER = "browser_action";
        public const string MCP_USE = "use_mcp_tool";
        public const string MCP_ACCESS = "access_mcp_resource";
        public const string MCP_DOCS = "load_mcp_documentation";
        public const string NEW_TASK = "new_task";
        public const string PLAN_MODE = "plan_mode_respond";
        public const string ACT_MODE = "act_mode_respond";
        public const string TODO = "focus_chain";
        public const string WEB_FETCH = "web_fetch";
        public const string WEB_SEARCH = "web_search";
        public const string CONDENSE = "condense";
        public const string SUMMARIZE_TASK = "summarize_task";
        public const string REPORT_BUG = "report_bug";
        public const string NEW_RULE = "new_rule";
        public const string APPLY_PATCH = "apply_patch";
        public const string GENERATE_EXPLANATION = "generate_explanation";
        public const string USE_SKILL = "use_skill";
        public const string USE_SUBAGENTS = "use_subagents";

        public static readonly string[] AllTools = new[]
        {
            ASK, ATTEMPT, BASH, FILE_EDIT, FILE_READ, FILE_NEW, SEARCH, LIST_FILES,
            LIST_CODE_DEF, BROWSER, MCP_USE, MCP_ACCESS, MCP_DOCS, NEW_TASK, PLAN_MODE,
            ACT_MODE, TODO, WEB_FETCH, WEB_SEARCH, CONDENSE, SUMMARIZE_TASK, REPORT_BUG,
            NEW_RULE, APPLY_PATCH, GENERATE_EXPLANATION, USE_SKILL, USE_SUBAGENTS,
        };
    }
}
