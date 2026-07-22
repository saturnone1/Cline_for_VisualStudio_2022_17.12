import { getCommandText, getToolPath, getToolPathFromUnknown, getSearchQuery, getSearchFilePattern, summarizeToolInput, summarizeToolOutput, getPatchPathsFromUnknown, parsePatchPaths, summarizeCommandOutput, summarizeCommandLabel, sanitizeConsoleOutput, stripCommandSentinel, tryParseJson, getAskResponseText, firstString, findLastIndex, shouldAutoApproveTool, mapToolName } from "./ToolCommandFormatting"
import { normalizeClineMessagePayload, isMeaninglessToolMessage, isMeaninglessPlaceholderMessage, isMeaninglessTextMessage, isJsonObjectString, isEmptyJsonObjectString, isEmptyTranscriptPlaceholder, isEmptyPlainObject, toProtoClineMessage, toProtoAsk, toProtoSay, getExternalUrlValue, normalizeMcpDisplayMode, stripLegacyMcpContext } from "./ConversationMessageProjection"
import { isToolTranscript, looksLikeReasoningNarration, looksLikeTokenizedReasoning, normalizeTranscriptText, stringifyPretty } from "./TranscriptTextPolicy"
import { shouldDropTokenizedReasoning, shouldFoldTextContentAsReasoning, shouldDelayAssistantTextUntilClassified, stripRawToolCallMarkup, normalizeReasoningTranscriptText, normalizeProgressTranscriptText, sanitizeProgressTranscriptForDisplay, normalizeAssistantTranscriptText } from "./TranscriptNormalization"
import { toolActivityEntriesFromMessage, toolTranscriptToActivityEntries, buildGroupedToolActivityText, formatToolActivitySection, buildTerminalActivityText, formatCompletedCommandActivity, normalizeTerminalOutputText, toolActivityEntryKey, uniqueToolActivityEntries, splitToolPaths, looksLikeCommandText, uniqueStrings } from "./ToolActivityFormatting"
import type { ToolActivityEntry } from "./ToolActivityFormatting"
import { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"
import { contentToText, toolInputToText, toolResultToText } from "./SdkContentConversion"

export function agentChunkToTranscriptText(chunk: unknown): string {
	if (typeof chunk === "string") {
		return agentChunkStringToTranscriptText(chunk)
	}

	const record = asRecord(chunk)
	if (Object.keys(record).length === 0) {
		return ""
	}

	const transcript = agentChunkRecordToTranscriptText(record)
	if (transcript || isKnownAgentEventRecord(record) || getString(record, "type")) {
		return transcript
	}
	return contentToText(chunk)
}

export function agentChunkToFoldedReasoningText(chunk: unknown): string {
	if (typeof chunk === "string") {
		return agentChunkStringToFoldedReasoningText(chunk)
	}

	const record = asRecord(chunk)
	if (Object.keys(record).length === 0) {
		return ""
	}

	return agentChunkRecordToFoldedReasoningText(record)
}

export function agentChunkToTerminalResult(chunk: unknown): { status: string; reason: string; text: string } | null {
	if (typeof chunk === "string") {
		const text = chunk.trim()
		if (!text) {
			return null
		}

		const parsed = tryParseJson(text)
		if (parsed !== undefined) {
			return agentChunkToTerminalResult(parsed)
		}

		const sequence = parseJsonObjectSequence(text)
		for (let index = sequence.length - 1; index >= 0; index--) {
			const terminal = agentChunkToTerminalResult(sequence[index])
			if (terminal) {
				return terminal
			}
		}

		const jsonLines = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => tryParseJson(line))
		if (jsonLines.length > 0 && jsonLines.every((item) => item !== undefined)) {
			for (let index = jsonLines.length - 1; index >= 0; index--) {
				const terminal = agentChunkToTerminalResult(jsonLines[index])
				if (terminal) {
					return terminal
				}
			}
		}

		return null
	}

	if (Array.isArray(chunk)) {
		for (let index = chunk.length - 1; index >= 0; index--) {
			const terminal = agentChunkToTerminalResult(chunk[index])
			if (terminal) {
				return terminal
			}
		}
		return null
	}

	return agentChunkRecordToTerminalResult(asRecord(chunk))
}

export function agentChunkRecordToTerminalResult(record: Record<string, unknown>): { status: string; reason: string; text: string } | null {
	const type = getString(record, "type")
	if (type === "done") {
		return {
			status: getString(record, "status") || "completed",
			reason: getString(record, "reason") || "done",
			text: getString(record, "text"),
		}
	}
	if (type === "run-finished") {
		const result = asRecord(record.result)
		return {
			status: getString(result, "status") || "completed",
			reason: "run-finished",
			text: getString(result, "outputText") || getString(record, "text"),
		}
	}
	if (type === "run-failed") {
		return {
			status: "failed",
			reason: "run-failed",
			text: getString(record, "text") || stringify(record.error),
		}
	}
	return null
}

export function agentChunkStringToTranscriptText(chunk: string): string {
	const text = chunk.trim()
	if (!text) {
		return ""
	}

	const parsed = tryParseJson(text)
	if (parsed !== undefined) {
		if (Array.isArray(parsed)) {
			return parsed.map((item) => agentChunkToTranscriptText(item)).filter(Boolean).join("\n\n")
		}

		const parsedRecord = asRecord(parsed)
		const parsedText = agentChunkRecordToTranscriptText(parsedRecord)
		if (parsedText) {
			return parsedText
		}
		if (isKnownAgentEventRecord(parsedRecord)) {
			return ""
		}
	}

	const sequence = parseJsonObjectSequence(text)
	if (sequence.length > 0) {
		const sequenceText = sequence.map((item) => agentChunkToTranscriptText(item)).filter(Boolean).join("\n\n")
		if (sequenceText || sequence.length > 0) {
			return sequenceText
		}
	}

	const jsonLines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => tryParseJson(line))
	if (jsonLines.length > 0 && jsonLines.every((item) => item !== undefined)) {
		const lineText = jsonLines.map((item) => agentChunkToTranscriptText(item)).filter(Boolean).join("\n\n")
		return lineText
	}

	return unknownAgentChunkTextToTranscriptText(text)
}

export function agentChunkStringToFoldedReasoningText(chunk: string): string {
	const text = chunk.trim()
	if (!text) {
		return ""
	}

	const parsed = tryParseJson(text)
	if (parsed !== undefined) {
		if (Array.isArray(parsed)) {
			return parsed.map((item) => agentChunkToFoldedReasoningText(item)).filter(Boolean).join("\n")
		}

		return agentChunkRecordToFoldedReasoningText(asRecord(parsed))
	}

	const sequence = parseJsonObjectSequence(text)
	if (sequence.length > 0) {
		return sequence.map((item) => agentChunkToFoldedReasoningText(item)).filter(Boolean).join("\n")
	}

	const jsonLines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => tryParseJson(line))
	if (jsonLines.length > 0 && jsonLines.every((item) => item !== undefined)) {
		return jsonLines.map((item) => agentChunkToFoldedReasoningText(item)).filter(Boolean).join("\n")
	}

	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	if (looksLikeTokenizedReasoning(lines)) {
		return ""
	}
	if (looksLikeReasoningNarration(text)) {
		return normalizeReasoningTranscriptText(text)
	}

	return ""
}

export function parseJsonObjectSequence(text: string) {
	const results: unknown[] = []
	let depth = 0
	let start = -1
	let inString = false
	let escaped = false

	for (let index = 0; index < text.length; index++) {
		const char = text[index]
		if (inString) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === "\"") {
				inString = false
			}
			continue
		}

		if (char === "\"") {
			inString = true
			continue
		}

		if (char === "{") {
			if (depth === 0) {
				start = index
			}
			depth++
		} else if (char === "}" && depth > 0) {
			depth--
			if (depth === 0 && start >= 0) {
				const parsed = tryParseJson(text.slice(start, index + 1))
				if (parsed === undefined) {
					return []
				}
				results.push(parsed)
				start = -1
			}
		}
	}

	return depth === 0 && results.length > 1 ? results : []
}

export function agentChunkRecordToTranscriptText(record: Record<string, unknown>): string {
	const type = getString(record, "type")
	if (!type) {
		const role = getString(record, "role")
		if (role) {
			return contentToText(record.content)
		}
		return ""
	}

	if (type === "iteration_start" || type === "iteration_end" || type === "usage" || type === "done") {
		return ""
	}

	if (type === "content_start" || type === "content_update" || type === "content_delta" || type === "content_end") {
		const contentType = getString(record, "contentType") || getString(record, "content_type")
		const text = agentContentEventToText(record)
		if (!text.trim() || contentType === "reasoning") {
			return ""
		}
		if (contentType === "text" && type !== "content_end") {
			return ""
		}
		if (contentType === "text" && (shouldDropTokenizedReasoning(text) || shouldFoldTextContentAsReasoning(text))) {
			return ""
		}
		return text
	}

	if (type === "text" || type === "thinking") {
		return ""
	}

	if (type === "tool_use" || type === "tool_result" || type === "file" || type === "image") {
		return contentToText([record])
	}

	if (type === "notice" || type === "status" || type === "error") {
		return firstString(record, ["message", "text", "error", "status"])
	}

	return ""
}

export function agentChunkRecordToFoldedReasoningText(record: Record<string, unknown>): string {
	const type = getString(record, "type")
	if (!type) {
		return ""
	}

	if (type === "content_start" || type === "content_update" || type === "content_delta" || type === "content_end") {
		const contentType = getString(record, "contentType") || getString(record, "content_type")
		if (contentType === "reasoning") {
			const text = agentContentEventToText(record)
			return shouldDropTokenizedReasoning(text) ? "" : normalizeReasoningTranscriptText(text)
		}
		if (contentType === "text") {
			const text = agentContentEventToText(record)
			if (type === "content_end") {
				return ""
			}
			return shouldFoldTextContentAsReasoning(text) ? normalizeReasoningTranscriptText(text) : ""
		}
		return ""
	}

	if (type === "thinking") {
		return normalizeReasoningTranscriptText(contentToText([record]))
	}

	return ""
}

export function isKnownAgentEventRecord(record: Record<string, unknown>) {
	const type = getString(record, "type")
	return Boolean(type) && (
		type === "iteration_start" ||
		type === "iteration_end" ||
		type === "usage" ||
		type === "done" ||
		type === "content_start" ||
		type === "content_update" ||
		type === "content_delta" ||
		type === "content_end" ||
		type === "notice" ||
		type === "status" ||
		type === "error"
	)
}

export function agentContentEventToText(record: Record<string, unknown>): string {
	const contentType = getString(record, "contentType") || getString(record, "content_type")
	if (contentType === "text" || contentType === "reasoning") {
		return firstString(record, ["text", "reasoning", "content", "accumulated", "delta"])
	}

	if (contentType === "tool" || contentType === "tool_use" || contentType === "tool_result") {
		const toolName = firstString(record, ["name", "toolName", "tool_name", "id"])
		const input = record.input ?? record.arguments ?? record.params ?? record.message
		const output = record.output ?? record.result ?? record.content
		if (output !== undefined) {
			return `Tool result: ${toolResultToText(output)}`
		}
		if (toolName || input !== undefined) {
			return `Tool: ${toolName || "tool"}${input !== undefined ? `\n${toolInputToText(input)}` : ""}`
		}
	}

	return ""
}

export function unknownAgentChunkTextToTranscriptText(text: string) {
	const trimmed = text.trim()
	if (!trimmed) {
		return ""
	}

	if (trimmed.startsWith("{\"type\":") || trimmed.startsWith("{'type':")) {
		return ""
	}

	const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	if (trimmed.length < 40 && !isToolTranscript(trimmed)) {
		return ""
	}
	if (looksLikeTokenizedReasoning(lines)) {
		return ""
	}
	if (!isToolTranscript(trimmed)) {
		return ""
	}

	return lines.length > 1 ? lines.join("\n") : trimmed
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function getStringArray(value: unknown, key: string) { const item = asRecord(value)[key]; return Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [] }
function getBoolean(value: unknown, key: string) { return asRecord(value)[key] === true }
function getNumber(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "number" && Number.isFinite(item) ? item : undefined }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function arrayOfRecords(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [] }
function stringify(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value) } catch { return String(value) } }
function truncateText(value: string, maxChars: number) { return value.length <= maxChars ? value : value.slice(0, maxChars) + "\n\n[truncated " + (value.length - maxChars) + " chars]" }
function formatProviderErrorForTranscript(value: unknown, language: "en" | "ko") { const text = stringify(value).trim(); return text || (language === "ko" ? "모델 제공자가 빈 오류를 반환했습니다." : "The model provider returned an empty error.") }
