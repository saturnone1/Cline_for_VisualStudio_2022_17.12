import fs from "node:fs"
import path from "node:path"
import type { AgentToolContext } from "@cline/shared"
import type { JsonRpcConnection } from "../ipc/types"
import { VisualStudioHostProvider } from "../host/VisualStudioHostProvider"

type ClineSdkModule = typeof import("@cline/sdk")
type ClineCoreInstance = Awaited<ReturnType<ClineSdkModule["ClineCore"]["create"]>>
type CoreSessionEvent = Parameters<ClineCoreInstance["subscribe"]>[0] extends (event: infer T) => void ? T : unknown
export type ToolApprovalResult = { approved: boolean; reason?: string }
export type AskQuestionResult = string

export type ClineSdkStatus = {
	mode: "sdk"
	packageName: string
	packageVersion: string | null
	started: boolean
	activeSessionId: string | null
	runtimeAddress?: string
	lastError?: string
}

export class ClineSdkRuntime {
	private readonly host: VisualStudioHostProvider
	private core: ClineCoreInstance | null = null
	private starting: Promise<ClineCoreInstance> | null = null
	private activeSessionId: string | null = null
	private lastError: string | undefined

	constructor(
		connection: JsonRpcConnection,
		private readonly sidecarRoot: string,
		private readonly onCoreEvent?: (event: CoreSessionEvent) => void,
		private readonly onToolApproval?: (request: unknown) => Promise<ToolApprovalResult>,
		private readonly onAskQuestion?: (question: string, options: string[]) => Promise<AskQuestionResult>,
	) {
		this.host = VisualStudioHostProvider.create(connection)
	}

	get status(): ClineSdkStatus {
		return {
			mode: "sdk",
			packageName: "@cline/sdk",
			packageVersion: this.readSdkVersion(),
			started: this.core !== null,
			activeSessionId: this.activeSessionId,
			runtimeAddress: this.core?.runtimeAddress,
			lastError: this.lastError,
		}
	}

	markSessionInactive(sessionId?: string) {
		if (!sessionId || this.activeSessionId === sessionId) {
			this.activeSessionId = null
		}
	}

	async ensureStarted() {
		const core = await this.getCore()
		const history = await core.listHistory({ limit: 5 }).catch(() => [])
		return {
			...this.status,
			historyCount: Array.isArray(history) ? history.length : 0,
		}
	}

	async startSession(params: unknown) {
		const core = await this.getCore()
		const request = asRecord(params)
		const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
		const cwd = stringValue(request.cwd) || workspaceRoots[0] || process.cwd()
		const config = asRecord(request.config)
		const providerId = stringValue(config.providerId) || stringValue(request.providerId) || process.env.CLINE_PROVIDER_ID || "anthropic"
		const modelId = stringValue(config.modelId) || stringValue(request.modelId) || process.env.CLINE_MODEL_ID || "claude-sonnet-4-6"
		const apiKey = stringValue(config.apiKey) || stringValue(request.apiKey) || process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || ""

		const systemPrompt =
			stringValue(config.systemPrompt) ||
			stringValue(request.systemPrompt) ||
			"You are Cline running inside Visual Studio 2022 through the VsClineAgent wrapper."
		const mode = agentMode(config.mode) || agentMode(request.mode) || "act"
		const requestedSessionId = stringValue(config.sessionId) || stringValue(request.sessionId)
		const userImages = stringArrayValue(request.userImages)
		const userFiles = stringArrayValue(request.userFiles)
		const startInput: any = {
			config: {
				...config,
				...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
				providerId,
				modelId,
				apiKey,
				cwd,
				workspaceRoot: stringValue(config.workspaceRoot) || cwd,
				mode,
				enableTools: config.enableTools !== false,
				enableSpawnAgent: config.enableSpawnAgent === true,
				enableAgentTeams: config.enableAgentTeams === true,
				systemPrompt,
			},
			prompt: stringValue(request.prompt) || "",
			interactive: request.interactive !== false,
			sessionMetadata: asRecord(request.sessionMetadata),
			toolPolicies: asRecord(request.toolPolicies),
			userImages: userImages.length > 0 ? userImages : undefined,
			userFiles: userFiles.length > 0 ? userFiles : undefined,
		}

		if (requestedSessionId) {
			this.activeSessionId = requestedSessionId
		}

		try {
			const result = await core.start(startInput)
			this.activeSessionId = result.sessionId || requestedSessionId || this.activeSessionId
			return result
		} catch (error) {
			if (requestedSessionId && this.activeSessionId === requestedSessionId) {
				this.activeSessionId = null
			}
			throw error
		}
	}

	async send(params: unknown) {
		const core = await this.getCore()
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.activeSessionId
		if (!sessionId) {
			throw new Error("No active Cline SDK session. Call sdk.startSession first.")
		}

		try {
			return await core.send({
				sessionId,
				prompt: stringValue(request.prompt) || "",
				mode: agentMode(request.mode),
				delivery: request.delivery === "queue" || request.delivery === "steer" ? request.delivery : undefined,
				userImages: stringArrayValue(request.userImages),
				userFiles: stringArrayValue(request.userFiles),
			})
		} catch (error) {
			if (this.activeSessionId === sessionId && /session not found/i.test(error instanceof Error ? error.message : String(error))) {
				this.activeSessionId = null
			}
			throw error
		}
	}

	async stop(params: unknown) {
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.activeSessionId
		if (!sessionId || !this.core) {
			return this.status
		}

		await this.core.stop(sessionId)
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = null
		}

		return this.status
	}

	async abort(params: unknown) {
		const core = await this.getCore()
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.activeSessionId
		if (!sessionId) {
			return this.status
		}

		await core.abort(sessionId)
		this.activeSessionId = sessionId
		return this.status
	}

	async listHistory(params: unknown) {
		const core = await this.getCore()
		const request = asRecord(params)
		const limit = numberValue(request.limit) || 50
		return core.listHistory({ limit })
	}

	async getSession(params: unknown) {
		const core = await this.getCore()
		const sessionId = stringValue(asRecord(params).sessionId) || this.activeSessionId
		if (!sessionId) {
			return null
		}
		return core.get(sessionId)
	}

	async readMessages(params: unknown) {
		const core = await this.getCore()
		const sessionId = stringValue(asRecord(params).sessionId) || this.activeSessionId
		if (!sessionId) {
			return []
		}
		return core.readMessages(sessionId)
	}

	async deleteSession(params: unknown) {
		const core = await this.getCore()
		const sessionId = stringValue(asRecord(params).sessionId)
		if (!sessionId) {
			return false
		}
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = null
		}
		return core.delete(sessionId)
	}

	async updateSession(params: unknown) {
		const core = await this.getCore()
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.activeSessionId
		if (!sessionId) {
			throw new Error("No Cline SDK session selected.")
		}
		return core.update(sessionId, {
			title: stringValue(request.title) || null,
			prompt: stringValue(request.prompt) || null,
			metadata: asRecord(request.metadata),
		})
	}

	async getUsage(params: unknown) {
		const core = await this.getCore()
		const sessionId = stringValue(asRecord(params).sessionId) || this.activeSessionId
		if (!sessionId) {
			return null
		}
		return core.getAccumulatedUsage(sessionId)
	}

	async restore(params: unknown) {
		const core = await this.getCore()
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.activeSessionId
		const checkpointRunCount = numberValue(request.checkpointRunCount)
		if (!sessionId || checkpointRunCount === undefined) {
			throw new Error("SDK restore requires sessionId and checkpointRunCount.")
		}

		const result = await core.restore({
			sessionId,
			checkpointRunCount,
			cwd: stringValue(request.cwd),
			restore: asRecord(request.restore),
			start: request.start as any,
		})
		if (result.sessionId) {
			this.activeSessionId = result.sessionId
		} else if (result.startResult?.sessionId) {
			this.activeSessionId = result.startResult.sessionId
		}
		return result
	}

	async listSettings(params: unknown) {
		const core = await this.getCore()
		return core.settings.list(asRecord(params))
	}

	async toggleSetting(params: unknown) {
		const core = await this.getCore()
		return core.settings.toggle(asRecord(params) as any)
	}

	async dispose() {
		const core = this.core
		this.core = null
		this.starting = null
		this.activeSessionId = null
		if (core) {
			await core.dispose("Visual Studio sidecar disconnected")
		}
	}

	private async getCore() {
		if (this.core) {
			return this.core
		}

		if (!this.starting) {
			this.starting = this.createCore()
				.then((core) => {
					this.core = core
					this.lastError = undefined
					return core
				})
				.catch((error) => {
					this.starting = null
					this.lastError = error instanceof Error ? error.message : String(error)
					throw error
				})
		}

		return this.starting
	}

	private async createCore() {
		const sdk = await importClineSdk()
		const defaultExecutors = sdk.createDefaultExecutors({
			applyPatch: { restrictToCwd: true },
		})
		const core = await sdk.ClineCore.create({
			clientName: "VsClineAgent",
			backendMode: "local",
			capabilities: {
				requestToolApproval: async (request: unknown) => {
					if (this.onToolApproval) {
						return this.onToolApproval(request)
					}

					return { approved: false, reason: "Visual Studio tool approval UI is not attached." }
					},
					toolExecutors: {
					readFile: async (request: { path: string; start_line?: number | null; end_line?: number | null }) => {
						const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
						const filePath = resolveWorkspacePath(request.path, workspaceRoots)
						const result = await this.host.workspaceClient.readTextFile({ path: filePath })
						if (!result.exists) {
							throw new Error(`File not found: ${filePath}`)
						}

						if (request.start_line || request.end_line) {
							const lines = result.content.split(/\r?\n/)
							const start = Math.max((request.start_line || 1) - 1, 0)
							const end = request.end_line ? Math.min(request.end_line, lines.length) : lines.length
							return lines.slice(start, end).join("\n")
						}

						return result.content
					},
					search: async (query: string, cwd: string) => {
						const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
						const searchRoot = resolveWorkspacePath(cwd, workspaceRoots)
						const result = await this.host.workspaceClient.searchFiles({ path: searchRoot, query, limit: 500 })
						return result.matches.join("\n")
					},
					bash: async (command: string | { command: string; args?: string[] }, cwd: string, context: AgentToolContext) => {
						const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
						const commandCwd = resolveWorkspacePath(cwd, workspaceRoots)
						const commandText =
							typeof command === "string"
								? command
								: [command.command, ...(command.args || [])].filter(Boolean).join(" ")
						const abortSignal = (context as AgentToolContext & { abortSignal?: AbortSignal }).abortSignal
						if (abortSignal?.aborted) {
							throw new Error("Command was cancelled before it started.")
						}

						const abortHandler = () => {
							this.host.workspaceClient.cancelCommands().catch(() => undefined)
						}
						abortSignal?.addEventListener("abort", abortHandler, { once: true })

						try {
							const result = await this.host.workspaceClient.executeCommandInTerminal({
								command: commandText,
								cwd: commandCwd,
								timeoutSeconds: 120,
							})
							if (abortSignal?.aborted) {
								throw new Error("Command was cancelled.")
							}
							return normalizeCommandResultForSdk(result)
						} finally {
							abortSignal?.removeEventListener("abort", abortHandler)
						}
					},
					editor: async (
						input: { path: string; old_text?: string | null; new_text: string; insert_line?: number | null },
						cwd: string,
						context?: AgentToolContext,
					) => {
						const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
						const filePath = resolveWorkspacePath(input.path, workspaceRoots, cwd)
						const current = await this.host.workspaceClient.readTextFile({ path: filePath })
						const before = current.exists ? current.content : ""
						let next = current.exists ? current.content : ""
						if (input.old_text) {
							if (!next.includes(input.old_text)) {
								throw new Error(`old_text not found in ${filePath}`)
							}
							next = next.replace(input.old_text, input.new_text)
						} else if (input.insert_line) {
							const lines = next.split(/\r?\n/)
							lines.splice(Math.max(input.insert_line - 1, 0), 0, input.new_text)
							next = lines.join("\n")
						} else {
							next = input.new_text
						}

						const beforePath = await this.writeChangeSnapshot(filePath, before, context)
						await this.host.workspaceClient.writeTextFile({ path: filePath, content: next })
						this.emitFileChanged({
							sessionId: (context as AgentToolContext & { sessionId?: string } | undefined)?.sessionId || this.activeSessionId || undefined,
							filePath,
							beforePath,
							afterPath: filePath,
							action: current.exists ? "modified" : "created",
							...countLineChanges(before, next),
						})
						return `Wrote ${filePath}`
					},
					applyPatch: async (input: { input: string }, cwd: string, context: AgentToolContext) => {
						const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
						const patchText = typeof input === "string" ? input : input.input
						const changes = parseApplyPatchChanges(patchText)
						const snapshots = []
						for (const change of changes) {
							const beforeFilePath = resolveWorkspacePath(change.path, workspaceRoots, cwd)
							const afterFilePath = resolveWorkspacePath(change.moveTo || change.path, workspaceRoots, cwd)
							const current = await this.host.workspaceClient.readTextFile({ path: beforeFilePath })
							const before = current.exists ? current.content : ""
							const beforePath = await this.writeChangeSnapshot(beforeFilePath, before, context, "before")
							snapshots.push({
								...change,
								beforeFilePath,
								afterFilePath,
								before,
								beforePath,
							})
						}

						const result = await defaultExecutors.applyPatch?.(input, cwd, context)

						for (const snapshot of snapshots) {
							const after = await this.host.workspaceClient.readTextFile({ path: snapshot.afterFilePath })
							const afterContent = after.exists ? after.content : ""
							const afterPath =
								after.exists
									? snapshot.afterFilePath
									: await this.writeChangeSnapshot(snapshot.afterFilePath, afterContent, context, "after")
							this.emitFileChanged({
								sessionId: (context as AgentToolContext & { sessionId?: string } | undefined)?.sessionId || this.activeSessionId || undefined,
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
						if (this.onAskQuestion) {
							return this.onAskQuestion(question, options)
						}

						throw new Error("Visual Studio follow-up question UI is not attached.")
					},
					submit: async (summary: string, verified: boolean) => {
						return `${verified ? "Verified" : "Submitted"}: ${summary}`
					},
				},
			},
			logger: {
				debug: (message: string, metadata?: unknown) => {
					this.logSdkMessage("debug", message, metadata)
				},
				log: (message: string, metadata?: unknown) => {
					this.logSdkMessage("info", message, metadata)
				},
			},
		})
		if (this.onCoreEvent) {
			core.subscribe(this.onCoreEvent)
		}

		return core
	}

	private logSdkMessage(level: string, message: string, metadata?: unknown) {
		this.host.envClient.debugLog({
			message: `[Cline SDK:${level}] ${message}${metadata ? ` ${JSON.stringify(metadata)}` : ""}`,
		}).catch(() => undefined)
	}

	private async writeChangeSnapshot(filePath: string, content: string, context?: AgentToolContext, suffix = "before") {
		const sessionId = (context as AgentToolContext & { sessionId?: string } | undefined)?.sessionId || this.activeSessionId || "session"
		const changeRoot = path.join(getLocalAppDataRoot(), "VsClineAgent", "changes", sanitizePathPart(sessionId))
		await fs.promises.mkdir(changeRoot, { recursive: true })
		const snapshotName = `${Date.now()}-${sanitizePathPart(path.basename(filePath) || "file")}.${suffix}`
		const snapshotPath = path.join(changeRoot, snapshotName)
		await fs.promises.writeFile(snapshotPath, content, "utf8")
		return snapshotPath
	}

	private emitFileChanged(payload: Record<string, unknown>) {
		;(this.onCoreEvent as ((event: unknown) => void) | undefined)?.({
			type: "vscline_file_changed",
			payload,
		})
	}

	private readSdkVersion() {
		const packagePath = path.join(this.sidecarRoot, "node_modules", "@cline", "sdk", "package.json")
		try {
			const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string }
			return packageJson.version || null
		} catch {
			return null
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown) {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function numberValue(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeCommandResultForSdk(result: unknown) {
	const limit = readPositiveIntEnv("VSCLINE_SDK_COMMAND_RESULT_CHARS", 20000)
	if (typeof result === "string") {
		return truncateText(result, limit)
	}

	const record = asRecord(result)
	if (Object.keys(record).length === 0) {
		return truncateText(String(result), limit)
	}

	const stdout = typeof record.stdout === "string" ? record.stdout : undefined
	const stderr = typeof record.stderr === "string" ? record.stderr : undefined
	return JSON.stringify({
		...record,
		stdout: stdout === undefined ? undefined : truncateText(stdout, limit),
		stderr: stderr === undefined ? undefined : truncateText(stderr, Math.min(limit, 8000)),
	})
}

function truncateText(value: string, maxChars: number) {
	if (value.length <= maxChars) {
		return value
	}

	return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`
}

function readPositiveIntEnv(name: string, fallback: number) {
	const value = Number.parseInt(process.env[name] || "", 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function stringArrayValue(value: unknown) {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function agentMode(value: unknown): "act" | "plan" | undefined {
	return value === "act" || value === "plan" ? value : undefined
}

function resolveWorkspacePath(inputPath: string, workspaceRoots: string[], basePath?: string) {
	if (!inputPath || inputPath.trim().length === 0) {
		throw new Error("Path is required.")
	}

	const roots = workspaceRoots.map((root) => path.resolve(root))
	const base = basePath && basePath.trim().length > 0 ? path.resolve(basePath) : roots[0]
	const resolved = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(base || process.cwd(), inputPath))
	const allowed = roots.some((root) => isPathInsideOrEqual(resolved, root))
	if (!allowed) {
		throw new Error(`Access denied: path outside Visual Studio workspace: ${inputPath}`)
	}

	return resolved
}

function isPathInsideOrEqual(candidate: string, root: string) {
	const relative = path.relative(root, candidate)
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

function getLocalAppDataRoot() {
	return process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd()
}

function sanitizePathPart(value: string) {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "item"
}

function countLineChanges(before: string, after: string) {
	const beforeLines = splitLinesForDiff(before)
	const afterLines = splitLinesForDiff(after)
	const cellCount = beforeLines.length * afterLines.length
	if (cellCount > 1_000_000) {
		return {
			additions: Math.max(afterLines.length - beforeLines.length, 0),
			deletions: Math.max(beforeLines.length - afterLines.length, 0),
		}
	}

	let previous = new Array(afterLines.length + 1).fill(0)
	for (let i = 1; i <= beforeLines.length; i++) {
		const current = new Array(afterLines.length + 1).fill(0)
		for (let j = 1; j <= afterLines.length; j++) {
			current[j] = beforeLines[i - 1] === afterLines[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
		}
		previous = current
	}

	const common = previous[afterLines.length]
	return {
		additions: Math.max(afterLines.length - common, 0),
		deletions: Math.max(beforeLines.length - common, 0),
	}
}

function splitLinesForDiff(value: string) {
	if (!value) {
		return []
	}
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
}

type PatchChange = {
	path: string
	moveTo?: string
	action: "created" | "modified" | "deleted"
}

function parseApplyPatchChanges(patchText: string): PatchChange[] {
	const changes: PatchChange[] = []
	let current: PatchChange | null = null
	const pushCurrent = () => {
		if (current) {
			changes.push(current)
			current = null
		}
	}

	for (const rawLine of patchText.split(/\r?\n/)) {
		const line = rawLine.trimEnd()
		if (line.startsWith("*** Add File: ")) {
			pushCurrent()
			current = { path: line.slice("*** Add File: ".length).trim(), action: "created" }
		} else if (line.startsWith("*** Update File: ")) {
			pushCurrent()
			current = { path: line.slice("*** Update File: ".length).trim(), action: "modified" }
		} else if (line.startsWith("*** Delete File: ")) {
			pushCurrent()
			changes.push({ path: line.slice("*** Delete File: ".length).trim(), action: "deleted" })
		} else if (line.startsWith("*** Move to: ") && current) {
			current.moveTo = line.slice("*** Move to: ".length).trim()
		}
	}
	pushCurrent()
	return changes.filter((change) => change.path.length > 0)
}

async function importClineSdk(): Promise<ClineSdkModule> {
	const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ClineSdkModule>
	return importEsm("@cline/sdk")
}
