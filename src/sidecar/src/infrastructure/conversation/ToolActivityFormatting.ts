import { getSearchFilePattern, getSearchQuery, mapToolName, stripCommandSentinel, summarizeCommandLabel, summarizeCommandOutput, tryParseJson } from "./ToolCommandFormatting"
import { normalizeProgressTranscriptText } from "./TranscriptNormalization"
import { isToolTranscript } from "./TranscriptTextPolicy"

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

export type ToolActivityEntry = { kind: "file" | "search" | "edit" | "command" | "tool"; label: string; detail?: string }

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function getNumber(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "number" && Number.isFinite(item) ? item : undefined }
function truncateText(value: string, maxChars: number) { return value.length <= maxChars ? value : value.slice(0, maxChars) + "\n\n[truncated " + (value.length - maxChars) + " chars]" }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
