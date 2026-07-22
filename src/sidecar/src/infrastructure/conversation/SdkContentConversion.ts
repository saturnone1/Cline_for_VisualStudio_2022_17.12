import { getCommandText, getToolPath, getToolPathFromUnknown, getSearchQuery, getSearchFilePattern, summarizeToolInput, summarizeToolOutput, getPatchPathsFromUnknown, parsePatchPaths, summarizeCommandOutput, summarizeCommandLabel, sanitizeConsoleOutput, stripCommandSentinel, tryParseJson, getAskResponseText, firstString, findLastIndex, shouldAutoApproveTool, mapToolName } from "./ToolCommandFormatting"
import { normalizeClineMessagePayload, isMeaninglessToolMessage, isMeaninglessPlaceholderMessage, isMeaninglessTextMessage, isJsonObjectString, isEmptyJsonObjectString, isEmptyTranscriptPlaceholder, isEmptyPlainObject, toProtoClineMessage, toProtoAsk, toProtoSay, getExternalUrlValue, normalizeMcpDisplayMode, stripLegacyMcpContext } from "./ConversationMessageProjection"
import { isToolTranscript, looksLikeReasoningNarration, looksLikeTokenizedReasoning, normalizeTranscriptText, stringifyPretty } from "./TranscriptTextPolicy"
import { shouldDropTokenizedReasoning, shouldFoldTextContentAsReasoning, shouldDelayAssistantTextUntilClassified, stripRawToolCallMarkup, normalizeReasoningTranscriptText, normalizeProgressTranscriptText, sanitizeProgressTranscriptForDisplay, normalizeAssistantTranscriptText } from "./TranscriptNormalization"
import { toolActivityEntriesFromMessage, toolTranscriptToActivityEntries, buildGroupedToolActivityText, formatToolActivitySection, buildTerminalActivityText, formatCompletedCommandActivity, normalizeTerminalOutputText, toolActivityEntryKey, uniqueToolActivityEntries, splitToolPaths, looksLikeCommandText, uniqueStrings } from "./ToolActivityFormatting"
import type { ToolActivityEntry } from "./ToolActivityFormatting"
import { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"

export function sdkContentToVisibleAssistantText(content: unknown): string {
	if (typeof content === "string") {
		return normalizeAssistantTranscriptText(content)
	}
	if (!Array.isArray(content)) {
		return ""
	}

	const text = content
		.map((block) => {
			const record = asRecord(block)
			if (getString(record, "type") !== "text") {
				return ""
			}
			return getString(record, "text")
		})
		.filter(Boolean)
		.join("\n\n")
	return normalizeAssistantTranscriptText(text)
}

export function sdkContentToReasoningText(content: unknown): string {
	if (!Array.isArray(content)) {
		return ""
	}

	const parts = content
		.map((block) => {
			const record = asRecord(block)
			const type = getString(record, "type")
			if (type === "thinking") {
				return normalizeReasoningTranscriptText(getString(record, "thinking"))
			}
			return ""
		})
		.filter(Boolean)
		.join("\n\n")

	return normalizeProgressTranscriptText(parts)
}

export function sdkContentToToolActivityEntries(content: unknown): ToolActivityEntry[] {
	if (typeof content === "string") {
		return isToolTranscript(content) ? toolTranscriptToActivityEntries(content) : []
	}
	if (!Array.isArray(content)) {
		return []
	}

	return content.flatMap((block) => {
		const record = asRecord(block)
		const type = getString(record, "type")
		if (type === "tool_use") {
			return toolTranscriptToActivityEntries(`Tool: ${getString(record, "name") || "tool"}\n${toolInputToText(record.input)}`)
		}
		if (type === "tool_result") {
			return toolTranscriptToActivityEntries(`Tool result: ${toolResultToText(record.content)}`)
		}
		if (type === "file") {
			const pathValue = getString(record, "path")
			return pathValue ? [{ kind: "file", label: pathValue }] : []
		}
		if (type === "text") {
			const text = getString(record, "text")
			return isToolTranscript(text) ? toolTranscriptToActivityEntries(text) : []
		}
		return []
	})
}

export function contentToText(content: unknown): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		if (isEmptyPlainObject(content)) {
			return ""
		}
		return stringify(content)
	}
	return content.map((block) => {
		const record = asRecord(block)
		const type = getString(record, "type")
		if (type === "text") {
			return getString(record, "text")
		}
		if (type === "thinking") {
			return getString(record, "thinking")
		}
		if (type === "tool_use") {
			return `Tool: ${getString(record, "name")}\n${toolInputToText(record.input)}`
		}
		if (type === "tool_result") {
			return `Tool result: ${toolResultToText(record.content)}`
		}
		if (type === "file") {
			return `File: ${getString(record, "path")}\n${getString(record, "content")}`
		}
		if (type === "image") {
			return "[image]"
		}
		return stringify(record)
	}).filter(Boolean).join("\n\n")
}

export function toolInputToText(input: unknown): string {
	const record = asRecord(input)
	const command = getString(record, "command")
	const files = Array.isArray(record.files) ? record.files.map((item) => asRecord(item)) : []
	const query = getString(record, "query")
	const pathValue = getString(record, "path")
	const patch = getString(record, "patch")
	if (command) {
		return command
	}
	if (files.length > 0) {
		return files.map((file) => {
			const pathText = getString(file, "path")
			const startLine = getNumber(file, "start_line")
			const endLine = getNumber(file, "end_line")
			if (startLine !== undefined || endLine !== undefined) {
				return `${pathText}:${startLine ?? 1}-${endLine ?? ""}`
			}
			return pathText
		}).filter(Boolean).join("\n")
	}
	if (query) {
		return query
	}
	if (pathValue) {
		return pathValue
	}
	if (patch) {
		return parsePatchPaths(patch).join("\n") || patch
	}
	return stringify(input)
}

export function toolResultToText(result: unknown): string {
	const text = contentToText(result)
	const parsed = tryParseJson(text)
	if (parsed !== undefined) {
		const summarized = summarizeCommandOutput(parsed)
		if (summarized && summarized !== stringify(parsed)) {
			return summarized
		}
		return stringifyPretty(parsed)
	}

	return text
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
