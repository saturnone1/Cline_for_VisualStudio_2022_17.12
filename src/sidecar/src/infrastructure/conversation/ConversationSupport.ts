import fs from "node:fs"
import path from "node:path"
import { normalizeProviderId } from "../../application/services/ProviderIdentity"

export function getCommandText(input: Record<string, unknown>) {
	const command = getString(input, "command")
	if (command) {
		const args = getStringArray(input, "args")
		return [command, ...args].filter(Boolean).join(" ")
	}

	const commands = input.commands
	if (Array.isArray(commands)) {
		return commands
			.map((item) => {
				if (typeof item === "string") {
					return item.trim()
				}
				const record = asRecord(item)
				const commandText = getString(record, "command") || getString(record, "cmd") || getString(record, "line")
				return [commandText, ...getStringArray(record, "args")].filter(Boolean).join(" ")
			})
			.filter(Boolean)
			.join(" && ")
	}

	return stringify(input)
}

export function getToolPath(input: Record<string, unknown>) {
	const direct =
		getString(input, "path") ||
		getString(input, "filePath") ||
		getString(input, "absolutePath") ||
		getString(input, "cwd") ||
		getString(input, "root") ||
		getString(input, "directory")
	if (direct) {
		return direct
	}

	const files = input.files
	if (Array.isArray(files) && files.length > 0) {
		const first = asRecord(files[0])
		return getString(first, "path") || getString(first, "filePath") || (typeof files[0] === "string" ? files[0] : "")
	}

	return ""
}

export function getToolPathFromUnknown(value: unknown): string {
	if (Array.isArray(value)) {
		for (const item of value) {
			const pathValue = getToolPathFromUnknown(item)
			if (pathValue) {
				return pathValue
			}
		}
		return ""
	}

	const record = asRecord(value)
	if (Object.keys(record).length === 0) {
		return ""
	}
	return getToolPath(record) || getString(record, "query")
}

export function getSearchQuery(value: unknown): string {
	if (Array.isArray(value)) {
		for (const item of value) {
			const query = getSearchQuery(item)
			if (query) {
				return query
			}
		}
		return ""
	}

	const record = asRecord(value)
	return (
		getString(record, "regex") ||
		getString(record, "query") ||
		getString(record, "pattern") ||
		getString(record, "searchText") ||
		getString(record, "term")
	)
}

export function getSearchFilePattern(value: unknown): string {
	if (Array.isArray(value)) {
		for (const item of value) {
			const pattern = getSearchFilePattern(item)
			if (pattern) {
				return pattern
			}
		}
		return ""
	}

	const record = asRecord(value)
	return getString(record, "filePattern") || getString(record, "glob") || getString(record, "include") || getString(record, "filesToInclude")
}

export function summarizeToolInput(input: Record<string, unknown>) {
	const patchPaths = getPatchPathsFromUnknown(input)
	if (patchPaths) {
		return `Patch files:\n${patchPaths}`
	}

	const pathValue = getToolPathFromUnknown(input)
	if (pathValue) {
		return pathValue
	}

	const command = getCommandText(input)
	if (command && command !== "{}") {
		return command
	}

	return stringify(input)
}

export function summarizeToolOutput(tool: string, output: unknown) {
	if (tool === "editedExistingFile") {
		const patchPaths = getPatchPathsFromUnknown(output)
		if (patchPaths) {
			return `Patch files:\n${patchPaths}`
		}
	}

	if (tool === "readFile") {
		const records = Array.isArray(output) ? output.map(asRecord) : [asRecord(output)]
		const paths = records.map((item) => getToolPathFromUnknown(item) || getString(item, "query")).filter(Boolean)
		if (paths.length > 0) {
			return paths.join("\n")
		}
	}

	if (tool === "searchFiles") {
		const query = getSearchQuery(output)
		const pathValue = getToolPathFromUnknown(output)
		const filePattern = getSearchFilePattern(output)
		return [query ? `Search: ${query}` : "", pathValue ? `Path: ${pathValue}` : "", filePattern ? `Files: ${filePattern}` : ""]
			.filter(Boolean)
			.join("\n") || truncateText(stringify(output), readPositiveIntEnv("VSCLINE_TOOL_OUTPUT_CHARS", 12000))
	}

	return truncateText(stringify(output), readPositiveIntEnv("VSCLINE_TOOL_OUTPUT_CHARS", 12000))
}

export function getPatchPathsFromUnknown(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map(getPatchPathsFromUnknown).filter(Boolean).join("\n")
	}

	const record = asRecord(value)
	const patchText = getString(record, "input") || getString(record, "patch")
	if (!patchText) {
		return ""
	}

	return parsePatchPaths(patchText).join("\n")
}

export function parsePatchPaths(patchText: string) {
	const paths: string[] = []
	for (const rawLine of patchText.split(/\r?\n/)) {
		const line = rawLine.trimEnd()
		const pathValue =
			line.startsWith("*** Add File: ")
				? line.slice("*** Add File: ".length).trim()
				: line.startsWith("*** Update File: ")
					? line.slice("*** Update File: ".length).trim()
					: line.startsWith("*** Delete File: ")
						? line.slice("*** Delete File: ".length).trim()
						: line.startsWith("*** Move to: ")
							? line.slice("*** Move to: ".length).trim()
							: ""
		if (pathValue && !paths.includes(pathValue)) {
			paths.push(pathValue)
		}
	}
	return paths
}

export function summarizeCommandOutput(output: unknown) {
	const text = stringify(output)
	const parsed = tryParseJson(text)
	const records = Array.isArray(parsed) ? parsed.map(asRecord) : [asRecord(parsed)]
	const summarized = records
		.map((record) => {
			const result = asRecord(tryParseJson(getString(record, "result")) ?? record.result)
			const stdout = sanitizeConsoleOutput(getString(result, "stdout"))
			const stderr = sanitizeConsoleOutput(getString(result, "stderr"))
			const exitCode = result.exitCode
			const commandId = getString(result, "commandId")
			const terminalId = getString(result, "terminalId")
			const cwd = getString(result, "cwd")
			const currentDirectory = getString(result, "currentDirectory")
			const durationMs = numberValue(result.durationMs)
			const status = getString(result, "status")
			const background = result.background === true
			const isHot = result.isHot === true
			const attachable = result.attachable === true
			const proceedWhileRunning = result.proceedWhileRunningAvailable === true
			const parts = [
				getString(record, "query"),
				commandId ? `commandId=${commandId}` : "",
				terminalId ? `terminal=${terminalId}` : "",
				cwd ? `cwd=${cwd}` : "",
				currentDirectory ? `currentDirectory=${currentDirectory}` : "",
				status ? `status=${status}` : "",
				typeof exitCode === "number" ? `exitCode=${exitCode}` : "",
				durationMs !== undefined ? `durationMs=${durationMs}` : "",
				background ? "background=true" : "",
				isHot ? "hotProcess=true" : "",
				attachable ? "attachable=true" : "",
				proceedWhileRunning ? "proceedWhileRunning=true" : "",
				result.stdoutTruncated === true ? "stdout truncated" : "",
				result.stderrTruncated === true ? "stderr truncated" : "",
				stdout ? `stdout:\n${truncateText(stdout, 1200)}` : "",
				stderr ? `stderr:\n${truncateText(stderr, 800)}` : "",
			]
			return parts.filter(Boolean).join("\n")
		})
		.filter(Boolean)
		.join("\n\n")
	return summarized || text
}

export function summarizeCommandLabel(output: unknown) {
	const parsed = typeof output === "string" ? tryParseJson(output) : output
	const records = Array.isArray(parsed) ? parsed.map(asRecord) : [asRecord(parsed)]
	return records
		.map((record) => {
			const result = asRecord(tryParseJson(getString(record, "result")) ?? record.result)
			const query = getString(record, "query")
			const exitCode = result.exitCode
			const commandId = getString(result, "commandId")
			return [query, commandId, typeof exitCode === "number" ? `exitCode=${exitCode}` : ""].filter(Boolean).join(" ")
		})
		.filter(Boolean)
		.join("\n")
}

export function sanitizeConsoleOutput(text: string) {
	const trimmed = stripCommandSentinel(text).trim()
	if (!trimmed) {
		return ""
	}
	const replacementCount = (trimmed.match(/\uFFFD|�/g) || []).length
	if (replacementCount >= 4 || replacementCount > trimmed.length / 20) {
		return "[console output omitted: text encoding could not be decoded reliably]"
	}
	return trimmed
}

export function stripCommandSentinel(text: string) {
	return text
		.split(/\r?\n/)
		.filter((line) => !/(?:^|>)__VSCLINE_COMMAND_(?:DONE__cmd-\d{6}__-?\d+|CWD__cmd-\d{6}__.*)\s*$/.test(line.trim()))
		.join("\n")
}

export function tryParseJson(value: string) {
	try {
		return JSON.parse(value) as unknown
	} catch {
		return undefined
	}
}

export function getAskResponseText(message: unknown) {
	const record = asRecord(message)
	const direct = firstString(record, ["text", "value", "response", "answer", "selected", "selectedOption", "option"])
	if (direct) {
		return direct
	}

	for (const key of ["askResponse", "response", "selection"]) {
		const nested = asRecord(record[key])
		const nestedValue = firstString(nested, ["text", "value", "response", "answer", "selected", "selectedOption", "option"])
		if (nestedValue) {
			return nestedValue
		}
	}

	return ""
}

export function firstString(record: Record<string, unknown>, keys: string[]) {
	for (const key of keys) {
		const value = getString(record, key)
		if (value.trim()) {
			return value
		}
	}
	return ""
}

export function findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index])) {
			return index
		}
	}
	return -1
}

export function shouldAutoApproveTool(toolName: string, autoApprovalSettings: unknown) {
	const settings = asRecord(autoApprovalSettings)
	const actions = asRecord(settings.actions)
	if (settings.enabled !== true) {
		return false
	}

	const mapped = mapToolName(toolName)
	if (mapped === "readFile" || mapped === "searchFiles") {
		return actions.readFiles === true || actions.readFilesExternally === true
	}
	if (mapped === "executeCommand") {
		return actions.executeSafeCommands === true || actions.executeAllCommands === true
	}
	if (mapped === "editedExistingFile") {
		return actions.editFiles === true || actions.editFilesExternally === true
	}
	if (mapped === "useMcpServer") {
		return actions.useMcp === true || actions.useMcpServers === true
	}

	return false
}

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

export function buildTaskInputWithAttachments(text: string, images: string[], files: string[]) {
	const attachments = [
		...images.map((image) => `Image: ${formatAttachmentSummaryValue(image)}`),
		...files.map((file) => `File: ${file}`),
	]
	return attachments.length > 0 ? `${text}\n\nAttachments:\n${attachments.join("\n")}` : text
}

export async function normalizeSdkImageInputs(images: string[]) {
	return (await Promise.all(images.map((image) => normalizeSdkImageInput(image)))).filter(Boolean)
}

export async function normalizeSdkImageInput(image: string) {
	const trimmed = image.trim()
	if (!trimmed) {
		return ""
	}

	if (/^(https?:|data:image\/)/i.test(trimmed)) {
		return trimmed
	}

	const localPath = trimmed.startsWith("file://") ? fileUrlToPath(trimmed) : trimmed
	const dataUri = await tryCreateImageDataUri(localPath)
	return dataUri
}

export function fileUrlToPath(value: string) {
	try {
		return decodeURIComponent(value.replace(/^file:\/\/\/?/i, "")).replace(/\//g, path.sep)
	} catch {
		return value
	}
}

export async function tryCreateImageDataUri(filePath: string) {
	try {
		if (!filePath || !(await fs.promises.stat(filePath)).isFile()) {
			return ""
		}

		const mimeType = getImageMimeType(filePath)
		if (!mimeType) {
			return ""
		}

		return `data:${mimeType};base64,${(await fs.promises.readFile(filePath)).toString("base64")}`
	} catch {
		return ""
	}
}

export function getImageMimeType(filePath: string) {
	const extension = path.extname(filePath).toLowerCase()
	switch (extension) {
		case ".png":
			return "image/png"
		case ".jpg":
		case ".jpeg":
			return "image/jpeg"
		case ".gif":
			return "image/gif"
		case ".webp":
			return "image/webp"
		case ".bmp":
			return "image/bmp"
		default:
			return ""
	}
}

export function formatAttachmentSummaryValue(value: string) {
	if (value.toLowerCase().startsWith("data:image/")) {
		const separatorIndex = value.toLowerCase().indexOf(";base64,")
		const mimeType = separatorIndex > "data:".length ? value.slice("data:".length, separatorIndex) : "image"
		return `[attached ${mimeType}]`
	}

	return value
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

export function createId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function createHistoryItem(id: string, task: string, cwd: string, modelId: string) {
	return {
		id,
		ts: Date.now(),
		task,
		tokensIn: 0,
		tokensOut: 0,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
		isFavorited: false,
		size: 0,
		cwdOnTaskInitialization: cwd,
		modelId,
	}
}

export function sdkSessionToHistoryItem(session: Record<string, unknown>) {
	const metadata = asRecord(session.metadata)
	const usage = normalizeUsageSnapshot(
		metadata.aggregateUsage || metadata.usage || session.aggregateUsage || session.usage || asRecord(session.snapshot).aggregateUsage,
	)
	const checkpoint = asRecord(metadata.checkpoint)
	const latestCheckpoint = asRecord(checkpoint.latest)
	const id = getString(session, "sessionId") || getString(session, "id") || createId()
	const task = stripLegacyMcpContext(
		getString(metadata, "title") || getString(session, "title") || getString(session, "prompt") || "LIG VS SDK task",
	)
	return {
		id,
		ts: getNumber(session, "updatedAt") || getNumber(session, "createdAt") || Date.now(),
		task,
		tokensIn: usage.inputTokens || 0,
		tokensOut: usage.outputTokens || 0,
		cacheWrites: usage.cacheWriteTokens || 0,
		cacheReads: usage.cacheReadTokens || 0,
		totalCost: getNumber(metadata, "totalCost") || usage.totalCost || 0,
		isFavorited: metadata.isFavorited === true,
		size: getNumber(session, "messageCount") || 0,
		cwdOnTaskInitialization: getString(session, "cwd") || getString(metadata, "cwd") || process.cwd(),
		modelId: getString(metadata, "modelId") || getString(session, "modelId") || "",
		latestCheckpointRunCount: getNumber(latestCheckpoint, "runCount"),
	}
}

export function removeDeletedHistoryItems(items: Array<Record<string, unknown>>, deletedTaskIds: Set<string>) {
	if (deletedTaskIds.size === 0) {
		return items
	}
	return items.filter((item) => !deletedTaskIds.has(String(item.id || "")))
}

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
			const text = stripLegacyMcpContext(contentToText(record.content))
			const entries = sdkContentToToolActivityEntries(record.content)
			if (result.length === 0) {
				result.push({ ts: ts + partOffset++, type: "say", say: "task", text })
			} else if (entries.length > 0) {
				toolEntries.push(...entries)
			} else if (text.trim()) {
				flushToolEntries(ts + partOffset++)
				flushReasoning(ts + partOffset++)
				result.push({ ts: ts + partOffset++, type: "say", say: "user_feedback", text })
			}
		} else if (role === "assistant") {
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

export function stripLegacyMcpContext(value: string) {
	return value.replace(/<lig-vs-mcp-context>[\s\S]*?<\/lig-vs-mcp-context>\s*/gi, "").trimStart()
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

export function extractCompletionTextFromResult(result: Record<string, unknown>, event: unknown): string {
	const eventRecord = asRecord(event)
	const candidates: unknown[] = [
		result.outputText,
		result.finalText,
		result.finalResponse,
		result.response,
		result.answer,
		result.text,
		eventRecord.outputText,
		eventRecord.finalText,
		eventRecord.finalResponse,
		eventRecord.response,
		eventRecord.answer,
		eventRecord.text,
		result.message,
		result.content,
		result.output,
		result.result,
		eventRecord.message,
		eventRecord.content,
		eventRecord.output,
	]

	for (const candidate of candidates) {
		const text = completionCandidateToText(candidate)
		if (text) {
			return text
		}
	}

	return ""
}

export function completionCandidateToText(value: unknown): string {
	if (value === undefined || value === null) {
		return ""
	}
	if (typeof value === "string") {
		return normalizeAssistantTranscriptText(value)
	}
	if (Array.isArray(value)) {
		return normalizeAssistantTranscriptText(completionContentBlocksToText(value))
	}
	const record = asRecord(value)
	if (Object.keys(record).length === 0) {
		return ""
	}

	for (const key of ["outputText", "finalText", "finalResponse", "response", "answer", "text", "message", "content", "output"]) {
		const text = completionCandidateToText(record[key])
		if (text) {
			return text
		}
	}

	return ""
}

export function completionContentBlocksToText(content: unknown[]): string {
	return content.map((block) => {
		if (typeof block === "string") {
			return block
		}
		const record = asRecord(block)
		const type = getString(record, "type")
		if (type === "text") {
			return getString(record, "text")
		}
		if (!type) {
			return completionCandidateToText(record)
		}
		return ""
	}).filter(Boolean).join("\n\n")
}

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

const RESUMED_CONVERSATION_MAX_MESSAGES = 40
export const RESUMED_CONVERSATION_MAX_CHARS = 20_000
const RESUMED_CONVERSATION_MAX_ENTRY_CHARS = 2_500

export function buildResumedConversationMessages(
	messages: Array<Record<string, unknown>>,
	prompt: string,
	maxChars = RESUMED_CONVERSATION_MAX_CHARS,
) {
	const currentPrompt = prompt.trim()
	const entries = messages
		.filter((message) => message.partial !== true)
		.map(clineMessageToResumedTranscriptEntry)
		.filter((entry): entry is { role: string; text: string } => Boolean(entry?.text))

	while (entries.length > 0 && normalizeTranscriptText(entries[entries.length - 1].text) === normalizeTranscriptText(currentPrompt)) {
		entries.pop()
	}

	if (entries.length === 0 || !currentPrompt) {
		return []
	}

	const selected: Array<{ role: string; text: string }> = []
	let totalChars = currentPrompt.length
	for (let index = entries.length - 1; index >= 0 && selected.length < RESUMED_CONVERSATION_MAX_MESSAGES; index--) {
		const entry = entries[index]
		const text = truncateText(entry.text, RESUMED_CONVERSATION_MAX_ENTRY_CHARS)
		if (totalChars + text.length > maxChars) {
			if (selected.length > 0) {
				break
			}
			selected.unshift({ ...entry, text: truncateText(text, Math.max(1_000, maxChars - totalChars)) })
			break
		}
		selected.unshift({ ...entry, text })
		totalChars += text.length
	}

	while (selected.length > 0 && selected[0].role !== "User" && selected[0].role !== "Tool") {
		selected.shift()
	}

	const restored: Array<{ role: "user" | "assistant"; content: string }> = []
	for (const entry of selected) {
		const role = entry.role === "Assistant" ? "assistant" : "user"
		const content =
			entry.role === "Tool"
				? `Tool result:\n${entry.text}`
				: entry.role === "System"
					? `Previous session status:\n${entry.text}`
					: entry.text
		const previous = restored[restored.length - 1]
		if (previous?.role === role) {
			previous.content += `\n\n${content}`
		} else {
			restored.push({ role, content })
		}
	}
	return restored
}

export function clineMessageToResumedTranscriptEntry(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	const text = resumedTranscriptTextForMessage(message)
	if (!text) {
		return null
	}

	if (say === "task" || say === "user_feedback") {
		return { role: "User", text }
	}
	if (say === "text") {
		return { role: "Assistant", text }
	}
	if (say === "tool" || say === "command_output" || say === "browser_action" || ask === "tool" || ask === "command") {
		return { role: "Tool", text }
	}
	if (ask === "followup" || ask === "plan_mode_respond" || ask === "act_mode_respond") {
		return { role: "Assistant", text }
	}
	if (say === "error" || ask === "api_req_failed") {
		return { role: "System", text }
	}
	return null
}

export function resumedTranscriptTextForMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	const text = getString(message, "text")
	if (!text || say === "completion_result" || ask === "completion_result" || say === "api_req_started" || say === "reasoning") {
		return ""
	}

	const parsed = asRecord(tryParseJson(text) ?? {})
	if (Object.keys(parsed).length === 0) {
		return normalizeAssistantTranscriptText(text)
	}

	if (ask === "command") {
		return getString(parsed, "command") || normalizeAssistantTranscriptText(text)
	}
	if (ask === "followup") {
		const question = getString(parsed, "question")
		const options = getStringArray(parsed, "options")
		return [question, options.length ? `Options: ${options.join(", ")}` : ""].filter(Boolean).join("\n")
	}
	if (say === "tool" || ask === "tool") {
		const label = getString(parsed, "tool") || getString(parsed, "path") || getString(parsed, "command") || "tool"
		const content = getString(parsed, "content") || getString(parsed, "error") || stringify(parsed)
		return `${label}\n${content}`
	}
	return normalizeAssistantTranscriptText(text)
}

export function mergeTextDelta(current: string, delta: string) {
	if (!delta) {
		return current
	}
	if (!current) {
		return delta
	}
	return current.endsWith(delta) ? current : current + delta
}

export function looksLikeTokenizedReasoning(lines: string[]) {
	if (lines.length < 5) {
		return false
	}

	const shortLines = lines.filter((line) => line.length <= 16).length
	const wordLikeShortLines = lines.filter((line) => /^[A-Za-z0-9가-힣'"().,!?-]+$/.test(line) && line.length <= 12).length
	const avgLength = lines.reduce((total, line) => total + line.length, 0) / lines.length
	return (shortLines / lines.length >= 0.72 && avgLength <= 12) || wordLikeShortLines / lines.length >= 0.6
}

export function looksLikeReasoningNarration(text: string) {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase()
	return normalized.startsWith("the user says") ||
		normalized.startsWith("user says") ||
		normalized.startsWith("no specific task") ||
		normalized.includes(" the user says ") ||
		normalized.startsWith("we need to") ||
		normalized.startsWith("probably ") ||
		normalized.startsWith("let's ") ||
		normalized.startsWith("i need to")
}

export function isToolTranscript(text: string) {
	const normalized = text.trim()
	return normalized.startsWith("Tool:") || normalized.startsWith("Tool result:")
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

export function stringifyPretty(value: unknown) {
	if (typeof value === "string") {
		return value
	}
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

export function normalizeTranscriptText(text: string) {
	return text.replace(/\s+/g, " ").trim()
}

export function findCheckpointRunCount(messages: Array<Record<string, unknown>>, messageTs?: number) {
	if (messageTs !== undefined) {
		const target = messages.find((message) => message.ts === messageTs)
		const targetRunCount = getNumber(target, "checkpointRunCount")
		if (targetRunCount !== undefined) {
			return targetRunCount
		}
	}

	for (let index = messages.length - 1; index >= 0; index--) {
		const runCount = getNumber(messages[index], "checkpointRunCount")
		if (runCount !== undefined) {
			return runCount
		}
	}
	return undefined
}

export function findCheckpointMessage(messages: Array<Record<string, unknown>>, checkpointRunCount: number, messageTs?: number) {
	if (messageTs !== undefined) {
		const target = messages.find((message) => message.ts === messageTs)
		if (getNumber(target, "checkpointRunCount") === checkpointRunCount) {
			return target
		}
	}

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (getNumber(message, "checkpointRunCount") === checkpointRunCount) {
			return message
		}
	}
	return undefined
}

export function buildSettingsToggleMap(items: Array<Record<string, unknown>>, scope: "global" | "local") {
	return Object.fromEntries(
		items
			.filter((item) => (scope === "global" ? isGlobalSettingsItem(item) : !isGlobalSettingsItem(item)))
			.map((item) => [settingsItemKey(item), item.enabled !== false]),
	)
}

export function isGlobalSettingsItem(item: Record<string, unknown>) {
	const source = getString(item, "source")
	return source === "global" || source === "global-plugin" || getString(item, "path").toLowerCase().includes("\\cline\\")
}

export function settingsItemKey(item: Record<string, unknown>) {
	return getString(item, "path") || getString(item, "id") || getString(item, "name") || createId()
}

export function settingsItemToSkillInfo(item: Record<string, unknown>) {
	return {
		name: getString(item, "name") || settingsItemKey(item),
		path: settingsItemKey(item),
		enabled: item.enabled !== false,
		description: getString(item, "description"),
	}
}

export function normalizeChangePath(filePath: string) {
	return path.resolve(filePath).toLowerCase()
}

export function mapToolName(toolName: string) {
	switch (toolName) {
		case "readFile":
		case "read_file":
		case "read":
		case "read_files":
			return "readFile"
		case "search":
		case "grep":
		case "glob":
		case "searchFiles":
		case "search_files":
		case "search_codebase":
			return "searchFiles"
		case "editor":
		case "edit":
		case "applyPatch":
		case "apply_patch":
			return "editedExistingFile"
		case "bash":
		case "executeCommand":
		case "execute_command":
		case "runCommand":
		case "run_command":
		case "run_commands":
			return "executeCommand"
		case "use_mcp_server":
		case "useMcpServer":
			return "useMcpServer"
		default:
			return toolName || "tool"
	}
}

export function toolActivityEntriesFromMessage(tool: string, text: string): ToolActivityEntry[] {
	const parsed = asRecord(tryParseJson(text) ?? {})
	const mappedTool = mapToolName(getString(parsed, "tool") || tool)
	if (isToolTranscript(text)) {
		return toolTranscriptToActivityEntries(text)
	}

	if (mappedTool === "executeCommand") {
		const command = getString(parsed, "command") || getString(parsed, "content")
		return command ? [{ kind: "command", label: command }] : []
	}

	if (mappedTool === "searchFiles") {
		const query = getSearchQuery(parsed) || getString(parsed, "regex") || getString(parsed, "content")
		const searchPath = getString(parsed, "path") || "/"
		const filePattern = getSearchFilePattern(parsed)
		return query ? [{ kind: "search", label: query, detail: [filePattern, searchPath].filter(Boolean).join(" in ") }] : []
	}

	if (mappedTool === "editedExistingFile") {
		const paths = splitToolPaths(getString(parsed, "path") || getString(parsed, "content"))
		return paths.map((filePath) => ({ kind: "edit", label: filePath }))
	}

	const paths = splitToolPaths(getString(parsed, "path") || getString(parsed, "content"))
	if (mappedTool === "readFile" && paths.length > 0) {
		return paths.map((filePath) => ({ kind: "file", label: filePath }))
	}

	const content = getString(parsed, "content") || text
	return content.trim() ? [{ kind: "tool", label: truncateText(content.trim(), 240) }] : []
}

export function toolTranscriptToActivityEntries(text: string): ToolActivityEntry[] {
	const trimmed = text.trim()
	const resultMatch = /^Tool result:\s*(.*)$/s.exec(trimmed)
	if (resultMatch) {
		const result = resultMatch[1].trim()
		const parsed = tryParseJson(result)
		const parsedRecord = asRecord(parsed)
		const query = getString(parsedRecord, "query")
		if (looksLikeCommandText(query)) {
			return [{ kind: "command", label: summarizeCommandLabel(parsed ?? result) || query }]
		}
		const commandSummary = summarizeCommandOutput(parsed ?? result)
		if (looksLikeCommandText(commandSummary)) {
			return [{ kind: "command", label: summarizeCommandLabel(parsed ?? result) || truncateText(commandSummary, 240) }]
		}
		const paths = splitToolPaths(commandSummary)
		if (paths.length > 0) {
			return paths.map((filePath) => ({ kind: "file", label: filePath }))
		}
		return commandSummary ? [{ kind: "tool", label: truncateText(commandSummary, 240) }] : []
	}

	const toolMatch = /^Tool:\s*([^\r\n]+)\s*([\s\S]*)$/i.exec(trimmed)
	if (!toolMatch) {
		return []
	}

	const mappedTool = mapToolName(toolMatch[1].trim())
	const body = toolMatch[2].trim()
	if (mappedTool === "searchFiles") {
		return body ? [{ kind: "search", label: body, detail: "/" }] : []
	}
	if (mappedTool === "editedExistingFile") {
		return splitToolPaths(body).map((filePath) => ({ kind: "edit", label: filePath }))
	}
	if (mappedTool === "readFile") {
		return splitToolPaths(body).map((filePath) => ({ kind: "file", label: filePath }))
	}
	return body ? [{ kind: "tool", label: `${toolMatch[1].trim()}: ${body}` }] : [{ kind: "tool", label: toolMatch[1].trim() }]
}

export function buildGroupedToolActivityText(entries: ToolActivityEntry[], running: boolean, language: "en" | "ko" = "ko") {
	const files = uniqueStrings(entries.filter((entry) => entry.kind === "file").map((entry) => entry.label))
	const searches = uniqueStrings(entries.filter((entry) => entry.kind === "search").map((entry) =>
		entry.detail ? `${entry.label} (${entry.detail})` : entry.label,
	))
	const edits = uniqueStrings(entries.filter((entry) => entry.kind === "edit").map((entry) => entry.label))
	const commands = uniqueStrings(entries.filter((entry) => entry.kind === "command").map((entry) => entry.label))
	const others = uniqueStrings(entries.filter((entry) => entry.kind === "tool").map((entry) => entry.label))
	const summaryParts = [
		files.length ? (language === "ko" ? `LIG VS가 파일 ${files.length}개를 읽음` : `LIG VS read ${files.length} file${files.length === 1 ? "" : "s"}`) : "",
		searches.length ? (language === "ko" ? `검색 ${searches.length}회 수행` : `ran ${searches.length} search${searches.length === 1 ? "" : "es"}`) : "",
		edits.length ? (language === "ko" ? `편집 ${edits.length}개 준비` : `prepared ${edits.length} edit${edits.length === 1 ? "" : "s"}`) : "",
		commands.length ? (language === "ko" ? `명령 ${commands.length}개 실행` : `ran ${commands.length} command${commands.length === 1 ? "" : "s"}`) : "",
		others.length ? (language === "ko" ? `도구 ${others.length}개 사용` : `used ${others.length} tool${others.length === 1 ? "" : "s"}`) : "",
	].filter(Boolean)
	const detailLimit = readPositiveIntEnv("VSCLINE_TOOL_ACTIVITY_ITEMS", 40)
	const sections = [
		formatToolActivitySection(language === "ko" ? "파일" : "Files", files, detailLimit, language),
		formatToolActivitySection(language === "ko" ? "검색" : "Searches", searches, detailLimit, language),
		formatToolActivitySection(language === "ko" ? "편집" : "Edits", edits, detailLimit, language),
		formatToolActivitySection(language === "ko" ? "명령" : "Commands", commands, 8, language),
		formatToolActivitySection(language === "ko" ? "도구" : "Tools", others, 12, language),
	].filter(Boolean)
	const body = sections.length ? `\n${sections.join("\n")}` : ""
	return `${summaryParts.join(", ") || (language === "ko" ? "LIG VS가 도구를 사용함" : "LIG VS used tools")}:\n${running ? (language === "ko" ? "진행 중" : "Running") : (language === "ko" ? "완료" : "Done")}${body}`
}

export function formatToolActivitySection(title: string, values: string[], limit: number, language: "en" | "ko" = "ko") {
	if (values.length === 0) {
		return ""
	}
	const visible = values.slice(0, Math.max(1, limit)).map((value) => `- ${value}`)
	const hiddenCount = values.length - visible.length
	return `${title}:\n${visible.join("\n")}${hiddenCount > 0 ? `\n- ... ${language === "ko" ? `${hiddenCount}개 더 있음` : `${hiddenCount} more`}` : ""}`
}

export function buildTerminalActivityText(
	activeCommands: Record<string, unknown>[],
	recentCommands: Record<string, unknown>[],
	outputLines: Record<string, unknown>[],
	state: Record<string, unknown>,
	language: "en" | "ko" = "ko",
) {
	const commandLimit = readPositiveIntEnv("VSCLINE_TERMINAL_ACTIVITY_COMMANDS", 8)
	const outputLimit = readPositiveIntEnv("VSCLINE_TERMINAL_ACTIVITY_LINES", 8)
	const commands = activeCommands
		.slice(0, commandLimit)
		.map((command) => {
			const commandId = getString(command, "commandId")
			const terminalId = getString(command, "terminalId")
			const status = getString(command, "status") || "running"
			const commandText = getString(command, "command")
			const processId = getNumber(command, "processId")
			const cwd = getString(command, "currentDirectory") || getString(command, "cwd")
			const isHot = command.isHot === true
			const background = command.background === true
			const reusable = command.isReusableShell === true
			const attachable = command.attachable === true
			const proceedWhileRunning = command.proceedWhileRunningAvailable === true
			const where = [
				terminalId ? `terminal ${terminalId}` : "",
				cwd ? `cwd ${cwd}` : "",
				processId ? `pid ${processId}` : "",
				reusable ? "reused shell" : "",
				isHot ? "hot process" : "",
				background ? "background" : "",
				attachable ? (language === "ko" ? "연결 가능" : "attachable") : "",
				proceedWhileRunning ? (language === "ko" ? "실행 중 계속 가능" : "proceed while running available") : "",
			].filter(Boolean).join(", ")
			return `- ${[commandId || "command", status, where].filter(Boolean).join(" ")}${commandText ? `: ${commandText}` : ""}`
		})
	const completedCommands = recentCommands
		.slice(-commandLimit)
		.map((command) => {
			const commandId = getString(command, "commandId")
			const terminalId = getString(command, "terminalId")
			const status = getString(command, "status") || "completed"
			const commandText = getString(command, "command")
			const exitCode = getNumber(command, "exitCode")
			const durationMs = getNumber(command, "durationMs")
			const cwd = getString(command, "currentDirectory") || getString(command, "cwd")
			const timedOut = command.timedOut === true
			const cancelled = command.cancelled === true
			const isHot = command.isHot === true
			const flags = [
				exitCode !== undefined ? `exit=${exitCode}` : "",
				durationMs !== undefined ? `${durationMs}ms` : "",
				cwd ? `cwd ${cwd}` : "",
				timedOut ? (language === "ko" ? "시간 초과" : "timed out") : "",
				cancelled ? (language === "ko" ? "취소됨" : "cancelled") : "",
				isHot ? "hot process" : "",
				terminalId ? `terminal ${terminalId}` : "",
			].filter(Boolean)
			return `- ${[commandId || "command", status, flags.length ? `(${flags.join(", ")})` : ""].filter(Boolean).join(" ")}${
				commandText ? `: ${commandText}` : ""
			}`
		})
	const lines = outputLines
		.slice(-outputLimit)
		.map((line) => {
			const commandId = getString(line, "commandId")
			const stream = getString(line, "stream") || "stdout"
			const text = normalizeTerminalOutputText(getString(line, "text"))
			if (!text) {
				return ""
			}
			const prefix = [commandId, stream].filter(Boolean).join(" ")
			return `${prefix ? `[${prefix}] ` : ""}${text}`
		})
		.filter(Boolean)
	const hiddenOutputCount = Math.max(0, outputLines.length - lines.length)
	const shell = getString(state, "shell")
	const shellState = getString(state, "shellState")
	const reuseMode = getString(state, "reuseMode")
	const currentDirectory = getString(state, "currentDirectory")
	const attachable = state.attachable === true
	const proceedWhileRunning = state.proceedWhileRunningAvailable === true
	const unretrievedOutputAvailable = state.unretrievedOutputAvailable === true
	const shellSummary = [
		shell,
		shellState,
		reuseMode,
		currentDirectory ? `cwd ${currentDirectory}` : "",
		attachable ? (language === "ko" ? "연결 가능" : "attachable") : "",
		proceedWhileRunning ? (language === "ko" ? "실행 중 계속 가능" : "proceed while running available") : "",
		unretrievedOutputAvailable ? (language === "ko" ? "새 출력 있음" : "new output available") : "",
	].filter(Boolean).join(" / ")
	const sections = [
		shellSummary ? `Shell: ${shellSummary}` : "",
		commands.length ? `${language === "ko" ? "실행 중인 명령" : "Running commands"}:\n${commands.join("\n")}` : "",
		completedCommands.length ? `${language === "ko" ? "최근 명령" : "Recent commands"}:\n${completedCommands.join("\n")}` : "",
		lines.length ? `${language === "ko" ? "최근 터미널 출력" : "Recent terminal output"}:\n${hiddenOutputCount > 0 ? `- ... ${language === "ko" ? `이전 줄 ${hiddenOutputCount}개` : `${hiddenOutputCount} earlier lines`}\n` : ""}${lines.map((line) => `- ${line}`).join("\n")}` : "",
	].filter(Boolean)
	if (sections.length === 0) {
		return ""
	}

	return truncateText(
		`${language === "ko" ? "터미널 실행 진행 중" : "Terminal running"}:\n${sections.join("\n")}`,
		readPositiveIntEnv("VSCLINE_TERMINAL_ACTIVITY_CHARS", 2000),
	)
}

export function formatCompletedCommandActivity(text: string, language: "en" | "ko" = "ko") {
	const normalized = normalizeProgressTranscriptText(text)
	if (!normalized) {
		return ""
	}

	const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	const commandLine = lines.find((line) => looksLikeCommandText(line)) || lines[0] || "command"
	const outputPreview = lines
		.filter((line) => line !== commandLine && !line.startsWith("__VSCLINE_COMMAND_DONE__"))
		.slice(0, 8)
		.join("\n")
	return truncateText(
		`${language === "ko" ? "터미널 실행 완료" : "Terminal completed"}:\n- ${commandLine}${outputPreview ? `\n${language === "ko" ? "최근 출력" : "Recent output"}:\n${outputPreview}` : ""}`,
		readPositiveIntEnv("VSCLINE_TERMINAL_ACTIVITY_CHARS", 2000),
	)
}

export function normalizeTerminalOutputText(text: string) {
	return stripCommandSentinel(text).replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter(Boolean).join(" / ")
}

export function toolActivityEntryKey(entry: ToolActivityEntry) {
	return `${entry.kind}:${entry.label}:${entry.detail || ""}`.toLowerCase()
}

export function uniqueToolActivityEntries(entries: ToolActivityEntry[]) {
	const seen = new Set<string>()
	const result: ToolActivityEntry[] = []
	for (const entry of entries) {
		const key = toolActivityEntryKey(entry)
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		result.push(entry)
	}
	return result
}

export function splitToolPaths(text: string) {
	return uniqueStrings(
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.map((line) => line.replace(/^[-*]\s+/, "").replace(/^Path:\s*/i, "").replace(/^File:\s*/i, ""))
			.filter((line) => line.length > 0)
			.filter((line) => !looksLikeCommandText(line))
			.filter((line) => !line.startsWith("{") && !line.startsWith("["))
			.filter((line) => /[\\/]/.test(line) || /\.[A-Za-z0-9]{1,8}(:\d+(-\d*)?)?$/.test(line)),
	)
}

export function looksLikeCommandText(text: string) {
	const normalized = text.trim().toLowerCase()
	return normalized.startsWith("cmd ") ||
		normalized.startsWith("cmd/") ||
		normalized.startsWith("powershell ") ||
		normalized.startsWith("pwsh ") ||
		normalized.startsWith("dir ") ||
		normalized.startsWith("type ") ||
		normalized.includes(" /c ")
}

export function uniqueStrings(values: string[]) {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

type ToolActivityEntry = { kind: "file" | "search" | "edit" | "command" | "tool"; label: string; detail?: string }
type NormalizedUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalCost?: number; reliable: boolean }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function getStringArray(value: unknown, key: string) { const item = asRecord(value)[key]; return Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [] }
function getBoolean(value: unknown, key: string) { return asRecord(value)[key] === true }
function getNumber(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "number" && Number.isFinite(item) ? item : undefined }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function booleanValue(value: unknown) { return typeof value === "boolean" ? value : undefined }
function arrayOfRecords(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [] }
function firstNumberValue(record: Record<string, unknown>, keys: string[]) { for (const key of keys) { const value = numberValue(record[key]); if (value !== undefined) return value } return undefined }
export function normalizeUsageSnapshot(value: unknown): NormalizedUsage {
	const usage = asRecord(value)
	const normalized: NormalizedUsage = {
		inputTokens: firstNumberValue(usage, ["inputTokens", "tokensIn", "promptTokens", "totalInputTokens"]),
		outputTokens: firstNumberValue(usage, ["outputTokens", "tokensOut", "completionTokens", "totalOutputTokens"]),
		cacheReadTokens: firstNumberValue(usage, ["cacheReadTokens", "cacheReads", "cache_read_tokens", "totalCacheReadTokens"]),
		cacheWriteTokens: firstNumberValue(usage, ["cacheWriteTokens", "cacheWrites", "cache_creation_input_tokens", "totalCacheWriteTokens"]),
		totalCost: firstNumberValue(usage, ["totalCost", "cost"]),
		reliable: false,
	}
	normalized.reliable = (normalized.inputTokens || 0) + (normalized.outputTokens || 0) + (normalized.cacheReadTokens || 0) + (normalized.cacheWriteTokens || 0) > 0 || (normalized.totalCost || 0) > 0
	return normalized
}
function stringify(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value) } catch { return String(value) } }
function truncateText(value: string, maxChars: number) { return value.length <= maxChars ? value : value.slice(0, maxChars) + "\n\n[truncated " + (value.length - maxChars) + " chars]" }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
function formatProviderErrorForTranscript(value: unknown, language: "en" | "ko") { const text = stringify(value).trim(); return text || (language === "ko" ? "모델 제공자가 빈 오류를 반환했습니다." : "The model provider returned an empty error.") }
