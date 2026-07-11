export type AgentEventPayload = Readonly<Record<string, unknown>>

export type AgentRuntimeEvent =
	| { type: "agent_event"; sessionId: string; event: AgentEventPayload; payload: AgentEventPayload }
	| { type: "vscline_file_changed"; payload: AgentEventPayload }
	| { type: "chunk" | "session_snapshot" | "team_progress" | "hook" | "pending_prompts" | "pending_prompt_submitted"; sessionId: string; payload: AgentEventPayload }
	| { type: "status"; sessionId: string; status: string; payload: AgentEventPayload }
	| { type: "ended"; sessionId: string; reason: string; payload: AgentEventPayload }
	| { type: "unknown"; originalType: string; payload: AgentEventPayload }

export function normalizeAgentRuntimeEvent(value: unknown): AgentRuntimeEvent {
	const record = asRecord(value)
	const originalType = readString(record.type)
	const payload = asRecord(record.payload)
	const sessionId = readString(payload.sessionId)

	switch (originalType) {
		case "agent_event":
			return { type: originalType, sessionId, event: asRecord(payload.event), payload }
		case "vscline_file_changed":
			return { type: originalType, payload }
		case "chunk":
		case "session_snapshot":
		case "team_progress":
		case "hook":
		case "pending_prompts":
		case "pending_prompt_submitted":
			return { type: originalType, sessionId, payload }
		case "status":
			return { type: originalType, sessionId, status: readString(payload.status), payload }
		case "ended":
			return { type: originalType, sessionId, reason: readString(payload.reason), payload }
		default:
			return { type: "unknown", originalType, payload }
	}
}

function asRecord(value: unknown): AgentEventPayload {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {}
}

function readString(value: unknown) {
	return typeof value === "string" ? value : ""
}
