import type { AgentEvent, AgentEventPayload, AgentRuntimeEvent, ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"

export function normalizeAgentRuntimeEvent(value: unknown): AgentRuntimeEvent {
	const record = asRecord(value)
	const originalType = readString(record.type)
	const payload = asRecord(record.payload)
	const sessionId = readString(payload.sessionId)

	switch (originalType) {
		case "agent_event":
			return { type: originalType, sessionId, event: translateClineAgentEvent(payload.event, sessionId), payload }
		case "vscline_file_changed":
			return { type: originalType, payload }
		case "chunk":
		case "session_snapshot":
		case "team_progress":
		case "hook":
		case "pending_prompts":
		case "pending_prompt_submitted":
			return { type: originalType, sessionId, payload }
		case "status": {
			const status = readString(payload.status)
			return { type: originalType, sessionId, status, lifecycle: lifecycleEvent(sessionId, status, payload), payload }
		}
		case "ended": {
			const reason = readString(payload.reason) || "ended"
			return { type: originalType, sessionId, reason, lifecycle: completionEvent(sessionId, reason, payload), payload }
		}
		default:
			return { type: "unknown", originalType, payload }
	}
}

export function translateClineAgentEvent(value: unknown, sessionId: string): AgentEvent {
	const raw = asRecord(value)
	const type = readString(raw.type)
	const contentType = readString(raw.contentType)
	const phase = contentPhase(type)

	if (phase && contentType === "text") {
		return {
			type: "TextDelta",
			sessionId,
			text: readString(raw.delta) || readString(raw.text) || readString(raw.accumulated),
			accumulated: readString(raw.accumulated),
			phase,
			raw,
		}
	}
	if (phase && contentType === "reasoning") {
		return {
			type: "ReasoningDelta",
			sessionId,
			text: readString(raw.reasoning) || readString(raw.text) || readString(raw.accumulated) || readString(raw.delta),
			phase,
			raw,
		}
	}
	if (type === "content_start" && contentType === "tool") {
		return { type: "ToolCallRequested", sessionId, toolName: readString(raw.toolName), input: raw.input, raw }
	}
	if (type === "content_end" && contentType === "tool") {
		return {
			type: "ToolCallCompleted",
			sessionId,
			toolName: readString(raw.toolName),
			input: raw.input,
			output: raw.output,
			error: readString(raw.error),
			iteration: readNumber(raw.iteration),
			raw,
		}
	}
	if (type === "content_update" && contentType === "tool") return { type: "ToolCallUpdated", sessionId, toolName: readString(raw.toolName), update: raw.update, raw }
	if (type === "iteration_start") {
		return { type: "AgentStarted", sessionId, iteration: readNumber(raw.iteration), raw }
	}
	if (type === "iteration_end") { const toolCallCount = readNumber(raw.toolCallCount) || 0; return { type: "IterationCompleted", sessionId, iteration: readNumber(raw.iteration), toolCallCount, hadToolCalls: raw.hadToolCalls === true || toolCallCount > 0, raw } }
	if (type === "notice") return { type: "NoticeReceived", sessionId, message: readString(raw.message), reason: readString(raw.reason), noticeType: readString(raw.noticeType), raw }
	if (type === "tool-finished") return { type: "ToolFinished", sessionId, toolCall: asRecord(raw.toolCall), result: asRecord(raw.result), message: raw.message, raw }
	if (type === "assistant-message") return { type: "AssistantMessageReceived", sessionId, message: asRecord(raw.message), raw }
	if (type === "run-finished") return { type: "RunFinished", sessionId, result: asRecord(raw.result), usage: asRecord(raw.usage), completion: completionFields(raw), raw }
	if (type === "run-failed") return { type: "RunFailed", sessionId, reason: readString(raw.reason) || "failed", raw }
	if (type === "usage") return { type: "UsageUpdated", sessionId, usage: asRecord(raw.usage), totalInputTokens: readNumber(raw.totalInputTokens), totalOutputTokens: readNumber(raw.totalOutputTokens), totalCacheReadTokens: readNumber(raw.totalCacheReadTokens), totalCacheWriteTokens: readNumber(raw.totalCacheWriteTokens), totalCost: readNumber(raw.totalCost), raw }
	if (type === "done") return { type: "AgentDone", sessionId, result: asRecord(raw.result), completion: completionFields(raw), raw }
	if (type === "error") return { type: "AgentError", sessionId, error: raw.error, raw }
	return { type: "AgentEventUnknown", sessionId, originalType: type, raw }
}

export function translateToolApprovalRequest(value: unknown, sessionId: string): ApprovalRequestedEvent {
	const raw = asRecord(value)
	return {
		type: "ApprovalRequested",
		sessionId,
		toolName: readString(raw.toolName) || readString(raw.name) || readString(raw.tool),
		input: asRecord(raw.input || raw.params || raw.arguments),
		raw,
	}
}

function lifecycleEvent(sessionId: string, status: string, raw: AgentEventPayload): AgentEvent {
	const normalized = status.trim().toLowerCase()
	if (["failed", "error", "cancelled", "stopped"].includes(normalized)) {
		return { type: "AgentFailed", sessionId, reason: status || "failed", raw }
	}
	if (["idle", "completed", "complete", "ended"].includes(normalized)) {
		return { type: "AgentCompleted", sessionId, reason: status || "completed", raw }
	}
	return { type: "AgentStarted", sessionId, raw }
}

function completionEvent(sessionId: string, reason: string, raw: AgentEventPayload): AgentEvent {
	return /fail|error|cancel|stop/i.test(reason)
		? { type: "AgentFailed", sessionId, reason, raw }
		: { type: "AgentCompleted", sessionId, reason, raw }
}

function contentPhase(type: string): "start" | "update" | "end" | null {
	if (type === "content_start") return "start"
	if (type === "content_update" || type === "content_delta") return "update"
	if (type === "content_end") return "end"
	return null
}

function asRecord(value: unknown): AgentEventPayload {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {}
}

function readString(value: unknown) {
	return typeof value === "string" ? value : ""
}

function readNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function completionFields(raw: AgentEventPayload) { return Object.fromEntries(["outputText", "finalText", "finalResponse", "response", "answer", "text", "message", "content", "output", "result"].filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]])) }
