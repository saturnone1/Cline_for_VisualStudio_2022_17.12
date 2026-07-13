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

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function getStringArray(value: unknown, key: string) { const item = asRecord(value)[key]; return Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [] }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function stringify(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value) } catch { return String(value) } }
function truncateText(value: string, maxChars: number) { return value.length <= maxChars ? value : value.slice(0, maxChars) + "\n\n[truncated " + (value.length - maxChars) + " chars]" }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
