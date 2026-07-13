import type { AgentEvent } from "../../domain/agent/AgentRuntimeEvent"
import { isBrowserToolName } from "../../features/browser/BrowserPolicy"
import { getCommandText, getPatchPathsFromUnknown, getSearchFilePattern, getSearchQuery, getToolPath, getToolPathFromUnknown, mapToolName, summarizeCommandOutput, summarizeToolOutput } from "./ToolCommandFormatting"
import { formatCompletedCommandActivity } from "./ToolActivityFormatting"

type Callbacks = Readonly<{
	noteActivity: (reason: string) => void
	clearReasoning: () => void
	clearPartial: () => void
	recordActivity: (tool: string, text: string) => void
	startTerminal: () => void
	stopTerminal: () => void
	finalPollTerminal: () => void
	postToolUse: (event: Extract<AgentEvent, { type: "ToolCallCompleted" }>) => void
	handleBrowser: (toolName: string, input: Record<string, unknown>, error: string) => void
	shouldSuppressTrackedEdit: (toolName: string, trackedPath: string) => boolean
	rememberSummary: (tool: string, text: string) => void
	appendTerminal: (text: string) => void
	moveProgressToEnd: () => void
	language: () => "en" | "ko"
}>

export class AgentToolEventProjector {
	constructor(private readonly callbacks: Callbacks) {}

	handle(event: AgentEvent) {
		switch (event.type) {
			case "ToolCallRequested": return this.requested(event)
			case "ToolCallUpdated": return this.updated(event)
			case "ToolCallCompleted": return this.completed(event)
			case "ToolFinished": return this.finished(event)
			default: return { handled: false, broadcast: true }
		}
	}

	private requested(event: Extract<AgentEvent, { type: "ToolCallRequested" }>) {
		this.callbacks.noteActivity("content_start:tool"); this.callbacks.clearReasoning(); this.callbacks.clearPartial()
		if (isCommand(event.toolName)) { const command = getCommandText(asRecord(event.input)); if (command) this.callbacks.recordActivity("executeCommand", JSON.stringify({ tool: "executeCommand", command })); this.callbacks.startTerminal() }
		return { handled: true, broadcast: true }
	}

	private updated(event: Extract<AgentEvent, { type: "ToolCallUpdated" }>) {
		this.callbacks.noteActivity("content_update:tool"); this.callbacks.clearReasoning()
		if (isCommand(event.toolName)) this.callbacks.startTerminal()
		const toolName = mapToolName(event.toolName)
		if (event.update !== undefined) this.callbacks.rememberSummary(toolName, JSON.stringify({ tool: toolName, path: getToolPathFromUnknown(event.update), content: summarizeToolOutput(toolName, event.update) }))
		return { handled: true, broadcast: true }
	}

	private completed(event: Extract<AgentEvent, { type: "ToolCallCompleted" }>) {
		this.callbacks.noteActivity("content_end:tool"); this.callbacks.clearReasoning(); this.callbacks.postToolUse(event)
		const input = asRecord(event.input), command = isCommand(event.toolName)
		if (command) { this.callbacks.stopTerminal(); this.callbacks.finalPollTerminal() }
		if (isBrowserToolName(event.toolName)) { this.callbacks.handleBrowser(event.toolName, input, event.error); return { handled: true, broadcast: false } }
		const mapped = mapToolName(event.toolName)
		const trackedPath = mapped === "editedExistingFile" ? getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input) || getToolPathFromUnknown(event.output) : ""
		if (this.callbacks.shouldSuppressTrackedEdit(event.toolName, trackedPath)) return { handled: true, broadcast: false }
		const text = command ? truncate(event.error || summarizeCommandOutput(event.output), readPositiveIntEnv("VSCLINE_COMMAND_OUTPUT_CHARS", 12000)) : JSON.stringify({ tool: mapped, path: mapped === "searchFiles" ? getToolPath(input) || getToolPath(asRecord(event.output)) || "/" : getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input) || getToolPathFromUnknown(event.output), regex: mapped === "searchFiles" ? getSearchQuery(input) || getSearchQuery(event.output) : undefined, filePattern: mapped === "searchFiles" ? getSearchFilePattern(input) || getSearchFilePattern(event.output) : undefined, content: event.error || summarizeToolOutput(mapped, event.output), error: event.error || undefined })
		this.callbacks.rememberSummary(mapped, text)
		if (command) { this.callbacks.appendTerminal(formatCompletedCommandActivity(text, this.callbacks.language())); this.callbacks.moveProgressToEnd() } else this.callbacks.recordActivity(mapped, text)
		return { handled: true, broadcast: true }
	}

	private finished(event: Extract<AgentEvent, { type: "ToolFinished" }>) {
		this.callbacks.noteActivity("tool-finished"); this.callbacks.clearReasoning()
		const mapped = mapToolName(readString(event.toolCall.toolName)), output = event.result.output ?? event.message, input = asRecord(event.toolCall.input)
		const text = JSON.stringify({ tool: mapped, path: getToolPathFromUnknown(input) || getToolPathFromUnknown(output), content: summarizeToolOutput(mapped, output), error: event.result.isError === true ? summarizeToolOutput(mapped, output) : undefined })
		this.callbacks.rememberSummary(mapped, text); this.callbacks.recordActivity(mapped, text)
		return { handled: true, broadcast: true }
	}
}

function isCommand(toolName: string) { return toolName === "bash" || toolName === "run_commands" }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function truncate(value: string, limit: number) { return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]` }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
