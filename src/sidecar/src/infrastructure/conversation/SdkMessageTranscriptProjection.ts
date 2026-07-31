import { getCommandText, getToolPath, getToolPathFromUnknown, getSearchQuery, getSearchFilePattern, summarizeToolInput, summarizeToolOutput, getPatchPathsFromUnknown, parsePatchPaths, summarizeCommandOutput, summarizeCommandLabel, sanitizeConsoleOutput, stripCommandSentinel, tryParseJson, getAskResponseText, firstString, findLastIndex, shouldAutoApproveTool, mapToolName } from "./ToolCommandFormatting"
import { normalizeClineMessagePayload, isMeaninglessToolMessage, isMeaninglessPlaceholderMessage, isMeaninglessTextMessage, isJsonObjectString, isEmptyJsonObjectString, isEmptyTranscriptPlaceholder, isEmptyPlainObject, toProtoClineMessage, toProtoAsk, toProtoSay, getExternalUrlValue, normalizeMcpDisplayMode, stripLegacyMcpContext } from "./ConversationMessageProjection"
import { isToolTranscript, looksLikeReasoningNarration, looksLikeTokenizedReasoning, normalizeTranscriptText, stringifyPretty } from "./TranscriptTextPolicy"
import { shouldDropTokenizedReasoning, shouldFoldTextContentAsReasoning, shouldDelayAssistantTextUntilClassified, stripRawToolCallMarkup, normalizeReasoningTranscriptText, normalizeProgressTranscriptText, sanitizeProgressTranscriptForDisplay, normalizeAssistantTranscriptText } from "./TranscriptNormalization"
import { toolActivityEntriesFromMessage, toolTranscriptToActivityEntries, buildGroupedToolActivityText, formatToolActivitySection, buildTerminalActivityText, formatCompletedCommandActivity, normalizeTerminalOutputText, toolActivityEntryKey, uniqueToolActivityEntries, splitToolPaths, looksLikeCommandText, uniqueStrings } from "./ToolActivityFormatting"
import type { ToolActivityEntry } from "./ToolActivityFormatting"
import { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"
import { sdkContentToReasoningText, sdkContentToToolActivityEntries, sdkContentToUserProjection, sdkContentToVisibleAssistantText } from "./SdkContentConversion"

export function sdkMessagesToClineMessages(messages: unknown, taskItem: Record<string, unknown>) {
	if (!Array.isArray(messages)) {
		return []
	}

	const result: Array<Record<string, unknown>> = []
	const toolEntries: ToolActivityEntry[] = []
	const reasoningParts: string[] = []
	let messageIndex = 0
	const flushToolEntries = (ts: number) => {
		const uniqueEntries = uniqueToolActivityEntries(toolEntries)
		if (uniqueEntries.length === 0) {
			return
		}

		result.push({
			ts,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request: buildGroupedToolActivityText(uniqueEntries, false),
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				cost: 0,
				usageReliable: false,
			}),
			partial: false,
			isCollapsed: true,
			isExpanded: false,
		})
		toolEntries.length = 0
	}
	const flushReasoning = (ts: number) => {
		const reasoning = uniqueStrings(reasoningParts)
			.filter((part) => part && part !== "모델 진행 중")
			.join("\n\n")
		if (!reasoning) {
			reasoningParts.length = 0
			return
		}

		result.push({
			ts,
			type: "say",
			say: "reasoning",
			text: "모델 내부 추론",
			reasoning,
			partial: false,
			isCollapsed: true,
			isExpanded: false,
		})
		reasoningParts.length = 0
	}

	for (const message of messages) {
		const record = asRecord(message)
		const role = getString(record, "role")
		const ts = sdkMessageTimestamp(record, taskItem, messageIndex++)
		let partOffset = 0
		if (role === "user") {
			const userContent = sdkContentToUserProjection(record.content)
			const text = stripLegacyMcpContext(userContent.text)
			const entries = sdkContentToToolActivityEntries(record.content)
			if (result.length === 0) {
				result.push({ ts: ts + partOffset++, type: "say", say: "task", text, images: userContent.images, files: userContent.files })
			} else if (entries.length > 0) {
				toolEntries.push(...entries)
			} else if (text.trim() || userContent.images.length > 0 || userContent.files.length > 0) {
				flushToolEntries(ts + partOffset++)
				flushReasoning(ts + partOffset++)
				result.push({ ts: ts + partOffset++, type: "say", say: "user_feedback", text, images: userContent.images, files: userContent.files })
			}
		} else if (role === "assistant") {
			const metrics = asRecord(record.metrics)
			const inputTokens = getNumber(metrics, "inputTokens")
			const outputTokens = getNumber(metrics, "outputTokens")
			const cacheReads = getNumber(metrics, "cacheReadTokens")
			const cacheWrites = getNumber(metrics, "cacheWriteTokens")
			const entries = sdkContentToToolActivityEntries(record.content)
			if (entries.length > 0) {
				toolEntries.push(...entries)
			}
			const folded = sdkContentToReasoningText(record.content)
			if (folded) {
				reasoningParts.push(folded)
			}
			const text = sdkContentToVisibleAssistantText(record.content)
			if (text) {
				flushToolEntries(ts + partOffset++)
				flushReasoning(ts + partOffset++)
				result.push({ ts: ts + partOffset++, type: "say", say: "text", text })
			}
			if ((inputTokens || 0) + (outputTokens || 0) + (cacheReads || 0) + (cacheWrites || 0) > 0) {
				result.push({
					ts: ts + partOffset++,
					type: "say",
					say: "api_req_started",
					text: JSON.stringify({ request: "", tokensIn: inputTokens || 0, tokensOut: outputTokens || 0, cacheReads: cacheReads || 0, cacheWrites: cacheWrites || 0, cost: getNumber(metrics, "cost") || 0, usageReliable: true }),
					partial: false,
					isCollapsed: true,
					isExpanded: false,
				})
			}
		}

		const metadata = asRecord(record.metadata)
		const checkpointRunCount = getNumber(metadata, "checkpointRunCount")
		if (checkpointRunCount !== undefined) {
			result.push({
				ts: ts + partOffset++,
				type: "say",
				say: "checkpoint_created",
				text: "SDK checkpoint",
				checkpointRunCount,
				checkpointTaskItem: taskItem,
			})
		}
	}
	const tailTs = stableSessionBaseTimestamp(taskItem) + (messageIndex + 1) * 10
	flushToolEntries(tailTs)
	flushReasoning(tailTs + 1)
	return result
}

export function sdkMessageTimestamp(message: Record<string, unknown>, taskItem: Record<string, unknown>, index: number) {
	const explicit =
		getNumber(message, "ts") ??
		getNumber(message, "timestamp") ??
		getNumber(message, "createdAt") ??
		getNumber(message, "updatedAt")
	if (explicit !== undefined) {
		return normalizeTimestamp(explicit) + index * 10
	}

	return stableSessionBaseTimestamp(taskItem) + index * 10
}

export function normalizeTimestamp(value: number) {
	return value > 0 && value < 10_000_000_000 ? value * 1000 : value
}

export function stableSessionBaseTimestamp(taskItem: Record<string, unknown>) {
	const id = getString(taskItem, "id") || getString(taskItem, "task") || "cline-sdk-session"
	return 1_700_000_000_000 + (hashString(id) % 1_000_000_000)
}

export function hashString(value: string) {
	let hash = 2166136261
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

export function partialMessageDeliveryKey(message: Record<string, unknown>) {
	return JSON.stringify({
		ts: numberValue(message.ts),
		type: getString(message, "type"),
		ask: getString(message, "ask"),
		say: getString(message, "say"),
		text: getString(message, "text"),
		reasoning: getString(message, "reasoning"),
		partial: message.partial === true,
		isCollapsed: message.isCollapsed === true,
		isExpanded: message.isExpanded === true,
	})
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
