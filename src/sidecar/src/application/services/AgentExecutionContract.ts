export const AGENT_EXECUTION_EVIDENCE_INSTRUCTION =
	"Use available tools whenever a request depends on external state or asks you to perform an action. " +
	"Do not report, summarize, or imply that an action succeeded until an actual tool result confirms it. " +
	"If a required tool is unavailable, denied, or fails, state that accurately instead of inventing a result. " +
	"Describe the verified scope precisely and never generalize results from tested operations to untested capabilities. " +
	"Do not end a turn immediately after announcing an action that still requires a tool call."
