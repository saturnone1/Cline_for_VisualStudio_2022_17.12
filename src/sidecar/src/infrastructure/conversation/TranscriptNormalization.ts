import { isEmptyJsonObjectString, isEmptyTranscriptPlaceholder } from "./ConversationMessageProjection"
import { looksLikeReasoningNarration, looksLikeTokenizedReasoning } from "./TranscriptTextPolicy"

export function shouldDropTokenizedReasoning(text: string) {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	return looksLikeTokenizedReasoning(lines)
}

export function shouldFoldTextContentAsReasoning(text: string) {
	return !shouldDropTokenizedReasoning(text) && looksLikeReasoningNarration(text)
}

export function shouldDelayAssistantTextUntilClassified(text: string) {
	const normalized = text.replace(/\s+/g, " ").trim()
	if (!normalized) {
		return false
	}
	if (normalized.length < 80) {
		return true
	}
	const lower = normalized.toLowerCase()
	return [
		"the user",
		"user ",
		"we ",
		"let",
		"probably",
		"maybe",
		"need ",
		"i ",
	].some((prefix) => lower.startsWith(prefix))
}

export function stripRawToolCallMarkup(text: string) {
	return text
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/invoke>\s*<\/[^>\s]*:?tool_call>/gi, "")
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/invoke>/gi, "")
		.replace(/<function=[\s\S]*?<\/function>\s*<\/tool_call>/gi, "")
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/tool_call>/gi, "")
		.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
		.replace(/<\/?[^>\s]*:?tool_call>/gi, "")
		.trim()
}

export function normalizeReasoningTranscriptText(text: string) {
	const trimmed = stripRawToolCallMarkup(text)
	if (!trimmed) {
		return ""
	}

	const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	if (looksLikeTokenizedReasoning(lines)) {
		return ""
	}

	return trimmed.replace(/\s+/g, " ")
}

export function normalizeProgressTranscriptText(text: string) {
	const trimmed = stripRawToolCallMarkup(text)
	if (!trimmed) {
		return ""
	}

	return trimmed
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
}

export function sanitizeProgressTranscriptForDisplay(text: string) {
	return stripRawToolCallMarkup(text)
		.split(/\r?\n/)
		.filter((line) => !isEmptyTranscriptPlaceholder(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

export function normalizeAssistantTranscriptText(text: string) {
	const trimmed = stripRawToolCallMarkup(text)
	if (!trimmed || isEmptyJsonObjectString(trimmed)) {
		return ""
	}

	return trimmed.replace(/\n{3,}/g, "\n\n")
}
