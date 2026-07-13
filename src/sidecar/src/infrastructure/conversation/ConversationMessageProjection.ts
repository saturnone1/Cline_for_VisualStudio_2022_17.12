import { tryParseJson } from "./ToolCommandFormatting"

export function normalizeClineMessagePayload(message: Record<string, unknown>) {
	const normalized = { ...message }
	const text = getString(normalized, "text")
	const say = getString(normalized, "say")
	const ask = getString(normalized, "ask")
	if ((say === "task" || say === "user_feedback") && text) {
		normalized.text = stripLegacyMcpContext(text)
	}

	if ((say === "tool" || ask === "tool") && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			tool: "unknown",
			content: text,
		})
	}

	if (say === "api_req_started" && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			request: text,
			tokensIn: 0,
			tokensOut: 0,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0,
			usageReliable: false,
		})
	}

	if (ask === "followup" && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			question: text,
			options: [],
		})
	}

	if (ask === "command" && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			command: text,
		})
	}

	return normalized
}

export function isMeaninglessToolMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	if (say !== "tool" && ask !== "tool") {
		return false
	}

	const text = getString(message, "text")
	if (text && !isJsonObjectString(text)) {
		return false
	}

	const parsed = asRecord(tryParseJson(text || "{}") ?? {})
	return (
		!getString(parsed, "tool") &&
		!getString(parsed, "path") &&
		!getString(parsed, "content") &&
		!getString(parsed, "command") &&
		!getString(parsed, "error")
	)
}

export function isMeaninglessPlaceholderMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	if (say !== "reasoning" && say !== "api_req_started") {
		return false
	}

	const text = getString(message, "text")
	if (!isEmptyTranscriptPlaceholder(text)) {
		return false
	}

	const images = Array.isArray(message.images) ? message.images : []
	const files = Array.isArray(message.files) ? message.files : []
	return images.length === 0 && files.length === 0 && !getString(message, "reasoning")
}

export function isMeaninglessTextMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	if (ask || say !== "text") {
		return false
	}
	return isEmptyJsonObjectString(getString(message, "text"))
}

export function isJsonObjectString(value: string) {
	try {
		const parsed = JSON.parse(value)
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
	} catch {
		return false
	}
}

export function isEmptyJsonObjectString(value: string) {
	const trimmed = value.trim()
	if (trimmed !== "{}") {
		return false
	}
	try {
		const parsed = JSON.parse(trimmed)
		return isEmptyPlainObject(parsed)
	} catch {
		return false
	}
}

export function isEmptyTranscriptPlaceholder(value: string) {
	const trimmed = value.trim()
	return trimmed === "{}" || trimmed === "[]" || trimmed === "null" || trimmed === "undefined"
}

export function isEmptyPlainObject(value: unknown) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0
}

export function toProtoClineMessage(message: Record<string, unknown>) {
	return {
		ts: numberValue(message.ts) || Date.now(),
		type: message.type === "ask" ? "ASK" : "SAY",
		ask: toProtoAsk(getString(message, "ask")),
		say: toProtoSay(getString(message, "say")),
		text: getString(message, "text"),
		reasoning: getString(message, "reasoning"),
		images: Array.isArray(message.images) ? message.images : [],
		files: Array.isArray(message.files) ? message.files : [],
		partial: message.partial === true,
		isCollapsed: message.isCollapsed === true,
		isExpanded: message.isExpanded === true,
		lastCheckpointHash: "",
		isCheckpointCheckedOut: false,
		isOperationOutsideWorkspace: false,
		conversationHistoryIndex: 0,
	}
}

export function toProtoAsk(ask: string) {
	const mapping: Record<string, string> = {
		followup: "FOLLOWUP",
		plan_mode_respond: "PLAN_MODE_RESPOND",
		act_mode_respond: "ACT_MODE_RESPOND",
		command: "COMMAND",
		command_output: "COMMAND_OUTPUT",
		completion_result: "COMPLETION_RESULT",
		tool: "TOOL",
		api_req_failed: "API_REQ_FAILED",
		resume_task: "RESUME_TASK",
		resume_completed_task: "RESUME_COMPLETED_TASK",
		mistake_limit_reached: "MISTAKE_LIMIT_REACHED",
		browser_action_launch: "BROWSER_ACTION_LAUNCH",
		use_mcp_server: "USE_MCP_SERVER",
		new_task: "NEW_TASK",
		condense: "CONDENSE",
		summarize_task: "SUMMARIZE_TASK",
		report_bug: "REPORT_BUG",
		use_subagents: "USE_SUBAGENTS",
	}
	return mapping[ask] || "FOLLOWUP"
}

export function toProtoSay(say: string) {
	const mapping: Record<string, string> = {
		task: "TASK",
		error: "ERROR",
		api_req_started: "API_REQ_STARTED",
		api_req_finished: "API_REQ_FINISHED",
		text: "TEXT",
		reasoning: "REASONING",
		completion_result: "COMPLETION_RESULT_SAY",
		user_feedback: "USER_FEEDBACK",
		user_feedback_diff: "USER_FEEDBACK_DIFF",
		api_req_retried: "API_REQ_RETRIED",
		command: "COMMAND_SAY",
		command_output: "COMMAND_OUTPUT_SAY",
		tool: "TOOL_SAY",
		info: "INFO",
		task_progress: "TASK_PROGRESS",
		hook_status: "HOOK_STATUS",
		hook_output_stream: "HOOK_OUTPUT_STREAM",
	}
	return mapping[say] || "TEXT"
}

export function getExternalUrlValue(message: unknown) {
	return getString(message, "value") || getString(message, "url") || getString(message, "uri") || getString(message, "href")
}

export function normalizeMcpDisplayMode(value: unknown, fallback: unknown = "plain") {
	const normalized = String(value || "").trim().toLowerCase()
	if (normalized === "rich" || normalized === "plain" || normalized === "markdown") {
		return normalized
	}

	const fallbackNormalized = String(fallback || "").trim().toLowerCase()
	return fallbackNormalized === "rich" || fallbackNormalized === "markdown" ? fallbackNormalized : "plain"
}

export function stripLegacyMcpContext(value: string) {
	return value.replace(/<lig-vs-mcp-context>[\s\S]*?<\/lig-vs-mcp-context>\s*/gi, "").trimStart()
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
