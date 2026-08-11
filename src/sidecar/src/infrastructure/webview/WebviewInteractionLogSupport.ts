import { tryParseJson } from "../conversation/ToolCommandFormatting"

export function shouldLogSdkEventForInteraction(event: unknown) {
	const record = asRecord(event)
	if (stringValue(record.type) !== "chunk") return true
	const payload = asRecord(record.payload)
	if (stringValue(payload.stream) !== "agent") return true
	const chunk = typeof payload.chunk === "string" ? asRecord(tryParseJson(payload.chunk) ?? {}) : asRecord(payload.chunk)
	return !(
		["content_start", "content_update", "content_delta"].includes(stringValue(chunk.type)) &&
		["reasoning", "text"].includes(stringValue(chunk.contentType))
	)
}

export function summarizeSdkEventForLog(event: unknown) {
	const record = asRecord(event), type = stringValue(record.type), payload = asRecord(record.payload)
	if (type === "agent_event") return { type, sessionId: stringValue(payload.sessionId), event: summarizeAgentChunkForLog(payload.event) }
	if (type === "chunk") return { type, sessionId: stringValue(payload.sessionId), stream: stringValue(payload.stream), chunk: summarizeAgentChunkForLog(payload.chunk) }
	if (type === "session_snapshot") {
		const snapshot = asRecord(payload.snapshot)
		return { type, sessionId: stringValue(payload.sessionId), status: stringValue(snapshot.status), messageCount: numberValue(snapshot.messageCount) }
	}
	return event
}

export function summarizeAgentChunkForLog(value: unknown) {
	if (typeof value === "string") return { kind: "string", length: value.length, preview: truncate(value, 240) }
	const record = asRecord(value)
	if (Object.keys(record).length === 0) return { kind: typeof value }
	return {
		type: stringValue(record.type),
		contentType: stringValue(record.contentType),
		toolName: stringValue(record.toolName),
		textLength: stringValue(record.text).length,
		accumulatedLength: stringValue(record.accumulated).length,
		reasoningLength: stringValue(record.reasoning).length,
		hasInput: Object.keys(asRecord(record.input)).length > 0,
		hasOutput: record.output !== undefined,
		hasUsage: record.usage !== undefined,
	}
}

export function summarizeClineMessageForLog(message: Record<string, unknown>) {
	const text = stringValue(message.text)
	return {
		ts: numberValue(message.ts),
		type: stringValue(message.type),
		say: stringValue(message.say),
		ask: stringValue(message.ask),
		partial: message.partial === true,
		textLength: text.length,
		textPreview: truncate(text, 240),
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function truncate(value: string, maxChars: number) {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}
