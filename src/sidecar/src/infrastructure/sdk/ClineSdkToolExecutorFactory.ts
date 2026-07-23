import type { AgentToolContext } from "@cline/shared"
import type { AskQuestionResult } from "../../application/ports/AgentInteraction"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import { normalizeCommandArgumentForPlatform, normalizeCommandForPlatform } from "../../application/services/CommandPolicy"
import { countLineChanges, parseApplyPatchChanges } from "../../application/services/PatchPolicy"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import { normalizeAgentRuntimeEvent } from "./ClineSdkEventTranslator"
import { resolveWorkspacePath } from "./SdkEnvironment"
import { fetchWebContentForSdk, normalizeCommandResultForSdk, readPositiveIntEnv } from "./SdkToolSupport"
import { writeChangeSnapshot as persistChangeSnapshot } from "./ChangeSnapshotStore"

type ClineSdkModule = typeof import("@cline/sdk")

type ToolExecutorDependencies = {
	host: HostProviderPort
	getActiveSessionId: () => string | null
	onAskQuestion?: (question: string, options: string[]) => Promise<AskQuestionResult>
	onEvent?: (event: AgentRuntimeEvent) => void
	log?: (event: string, details: Record<string, unknown>) => void
}

export function createClineSdkToolExecutors(sdk: ClineSdkModule, dependencies: ToolExecutorDependencies) {
	const defaultExecutors = sdk.createDefaultExecutors({ applyPatch: { restrictToCwd: true } })
	const { host } = dependencies

	return {
		readFile: async (request: { path: string; start_line?: number | null; end_line?: number | null }) => {
			const workspaceRoots = await host.workspaceClient.getWorkspacePaths({})
			const filePath = resolveWorkspacePath(request.path, workspaceRoots)
			const result = asRecord(await host.workspaceClient.readTextFile({ path: filePath }))
			if (result.exists !== true) throw new Error(`File not found: ${filePath}`)
			const content = stringValue(result.content) || ""

			if (request.start_line || request.end_line) {
				const lines = content.split(/\r?\n/)
				const start = Math.max((request.start_line || 1) - 1, 0)
				const end = request.end_line ? Math.min(request.end_line, lines.length) : lines.length
				return lines.slice(start, end).join("\n")
			}
			return boundToolOutput(content, readPositiveIntEnv("VSCLINE_READ_FILE_OUTPUT_CHARS", 64 * 1024), "File output", "Request a start_line/end_line range to read omitted content.")
		},
		search: async (query: string, cwd: string) => {
			const workspaceRoots = await host.workspaceClient.getWorkspacePaths({})
			const searchRoot = resolveWorkspacePath(cwd, workspaceRoots)
			const result = asRecord(await host.workspaceClient.searchFiles({ path: searchRoot, query, limit: 500 }))
			return boundToolOutput((Array.isArray(result.matches) ? result.matches : []).map(String).join("\n"), readPositiveIntEnv("VSCLINE_SEARCH_OUTPUT_CHARS", 48 * 1024), "Search output", "Narrow the query or search path to retrieve omitted matches.")
		},
		bash: async (command: string | { command: string; args?: string[] }, cwd: string, context: AgentToolContext) => {
			const workspaceRoots = await host.workspaceClient.getWorkspacePaths({})
			const commandCwd = resolveWorkspacePath(cwd, workspaceRoots)
			const commandText = typeof command === "string"
				? normalizeCommandForPlatform(command, process.platform)
				: normalizeCommandForPlatform([command.command, ...(command.args || []).map((argument) => normalizeCommandArgumentForPlatform(argument, process.platform))].filter(Boolean).join(" "), process.platform)
			const abortSignal = context.signal ?? (context as AgentToolContext & { abortSignal?: AbortSignal }).abortSignal
			if (abortSignal?.aborted) throw new Error("Command was cancelled before it started.")

			const abortHandler = () => { host.workspaceClient.cancelCommands().catch(() => undefined) }
			abortSignal?.addEventListener("abort", abortHandler, { once: true })
			try {
				const result = await host.workspaceClient.executeCommandInTerminal({
					command: commandText,
					cwd: commandCwd,
					timeoutSeconds: readPositiveIntEnv("VSCLINE_COMMAND_TIMEOUT_SECONDS", 120),
				})
				if (abortSignal?.aborted) throw new Error("Command was cancelled.")
				return normalizeCommandResultForSdk(result)
			} finally {
				abortSignal?.removeEventListener("abort", abortHandler)
			}
		},
		webFetch: async (urlOrRequest: string | { url?: string; prompt?: string }, promptOrContext?: string | AgentToolContext, context?: AgentToolContext) => {
			const url = typeof urlOrRequest === "string" ? urlOrRequest : stringValue(urlOrRequest.url) || ""
			const prompt = typeof urlOrRequest === "string"
				? typeof promptOrContext === "string" ? promptOrContext : ""
				: stringValue(urlOrRequest.prompt) || ""
			const toolContext = (typeof promptOrContext === "object" ? promptOrContext : context) as AgentToolContext | undefined
			const startedAt = Date.now()
			dependencies.log?.("webFetch.started", { host: safeUrlHost(url) })
			try {
				const result = await fetchWebContentForSdk(url, prompt, toolContext)
				dependencies.log?.("webFetch.completed", { host: safeUrlHost(url), durationMs: Date.now() - startedAt, resultChars: result.length })
				return result
			} catch (error) {
				dependencies.log?.("webFetch.failed", { host: safeUrlHost(url), durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })
				throw error
			}
		},
		editor: async (input: { path: string; old_text?: string | null; new_text: string; insert_line?: number | null }, cwd: string, context?: AgentToolContext) => {
			const workspaceRoots = await host.workspaceClient.getWorkspacePaths({})
			const filePath = resolveWorkspacePath(input.path, workspaceRoots, cwd)
			const current = asRecord(await host.workspaceClient.readTextFile({ path: filePath }))
			const before = current.exists === true ? stringValue(current.content) || "" : ""
			let next = before
			if (input.old_text) {
				if (!next.includes(input.old_text)) throw new Error(`old_text not found in ${filePath}`)
				next = next.replace(input.old_text, input.new_text)
			} else if (input.insert_line) {
				const lines = next.split(/\r?\n/)
				lines.splice(Math.max(input.insert_line - 1, 0), 0, input.new_text)
				next = lines.join("\n")
			} else {
				next = input.new_text
			}

			const beforePath = await persistChangeSnapshot(filePath, before, sessionIdFrom(context, dependencies) || "session")
			await host.workspaceClient.writeTextFile({ path: filePath, content: next })
			emitFileChanged(dependencies, {
				sessionId: sessionIdFrom(context, dependencies),
				filePath,
				beforePath,
				afterPath: filePath,
				action: current.exists === true ? "modified" : "created",
				...countLineChanges(before, next),
			})
			return `Wrote ${filePath}`
		},
		applyPatch: async (input: { input: string }, cwd: string, context: AgentToolContext) => {
			const workspaceRoots = await host.workspaceClient.getWorkspacePaths({})
			const patchText = typeof input === "string" ? input : input.input
			const snapshots = []
			for (const change of parseApplyPatchChanges(patchText)) {
				const beforeFilePath = resolveWorkspacePath(change.path, workspaceRoots, cwd)
				const afterFilePath = resolveWorkspacePath(change.moveTo || change.path, workspaceRoots, cwd)
				const current = asRecord(await host.workspaceClient.readTextFile({ path: beforeFilePath }))
				const before = current.exists === true ? stringValue(current.content) || "" : ""
				const beforePath = await persistChangeSnapshot(beforeFilePath, before, sessionIdFrom(context, dependencies) || "session")
				snapshots.push({ ...change, beforeFilePath, afterFilePath, before, beforePath })
			}

			const result = await defaultExecutors.applyPatch?.(input, cwd, context)
			for (const snapshot of snapshots) {
				const after = asRecord(await host.workspaceClient.readTextFile({ path: snapshot.afterFilePath }))
				const afterContent = after.exists === true ? stringValue(after.content) || "" : ""
				const afterPath = after.exists === true
					? snapshot.afterFilePath
					: await persistChangeSnapshot(snapshot.afterFilePath, afterContent, sessionIdFrom(context, dependencies) || "session", "after")
				emitFileChanged(dependencies, {
					sessionId: sessionIdFrom(context, dependencies),
					filePath: snapshot.afterFilePath,
					beforePath: snapshot.beforePath,
					afterPath,
					action: snapshot.action,
					...countLineChanges(snapshot.before, afterContent),
				})
			}
			return result || `Applied patch to ${snapshots.map((snapshot) => snapshot.afterFilePath).join(", ")}`
		},
		askQuestion: async (question: string, options: string[]) => {
			if (dependencies.onAskQuestion) return dependencies.onAskQuestion(question, options)
			throw new Error("Visual Studio follow-up question UI is not attached.")
		},
		submit: async (summary: string, verified: boolean) => `${verified ? "Verified" : "Submitted"}: ${summary}`,
	}
}

function emitFileChanged(dependencies: ToolExecutorDependencies, payload: Record<string, unknown>) {
	dependencies.onEvent?.(normalizeAgentRuntimeEvent({ type: "vscline_file_changed", payload }))
}

function sessionIdFrom(context: AgentToolContext | undefined, dependencies: ToolExecutorDependencies) {
	return (context as AgentToolContext & { sessionId?: string } | undefined)?.sessionId || dependencies.getActiveSessionId() || undefined
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function safeUrlHost(value: string) {
	try { return new URL(value).host }
	catch { return "invalid" }
}

export function boundToolOutput(value: string, maxChars: number, label: string, guidance = "") {
	if (value.length <= maxChars) return value
	const safeLimit = Math.max(1_024, maxChars)
	const tailChars = Math.min(Math.floor(safeLimit / 4), 16 * 1024)
	const headChars = safeLimit - tailChars
	const omitted = value.length - headChars - tailChars
	return [value.slice(0, headChars), `\n\n[${label} truncated: ${omitted} characters omitted. ${guidance}]\n\n`, value.slice(-tailChars)].join("")
}
