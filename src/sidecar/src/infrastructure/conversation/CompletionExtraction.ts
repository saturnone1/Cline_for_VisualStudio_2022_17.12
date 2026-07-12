import { normalizeAssistantTranscriptText } from "./ConversationSupport"

export function extractCompletionTextFromResult(result: Record<string, unknown>, event: unknown): string {
	const eventRecord = asRecord(event)
	const candidates: unknown[] = [
		result.outputText, result.finalText, result.finalResponse, result.response, result.answer, result.text,
		eventRecord.outputText, eventRecord.finalText, eventRecord.finalResponse, eventRecord.response, eventRecord.answer, eventRecord.text,
		result.message, result.content, result.output, result.result,
		eventRecord.message, eventRecord.content, eventRecord.output,
	]
	for (const candidate of candidates) {
		const text = completionCandidateToText(candidate)
		if (text) return text
	}
	return ""
}

export function completionCandidateToText(value: unknown): string {
	if (value === undefined || value === null) return ""
	if (typeof value === "string") return normalizeAssistantTranscriptText(value)
	if (Array.isArray(value)) return normalizeAssistantTranscriptText(completionContentBlocksToText(value))
	const record = asRecord(value)
	if (Object.keys(record).length === 0) return ""
	for (const key of ["outputText", "finalText", "finalResponse", "response", "answer", "text", "message", "content", "output"]) {
		const text = completionCandidateToText(record[key])
		if (text) return text
	}
	return ""
}

export function completionContentBlocksToText(content: unknown[]): string {
	return content.map((block) => {
		if (typeof block === "string") return block
		const record = asRecord(block)
		const type = getString(record, "type")
		if (type === "text") return getString(record, "text")
		return type ? "" : completionCandidateToText(record)
	}).filter(Boolean).join("\n\n")
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function getString(value: unknown, key: string) {
	const item = asRecord(value)[key]
	return typeof item === "string" ? item : item == null ? "" : String(item)
}
