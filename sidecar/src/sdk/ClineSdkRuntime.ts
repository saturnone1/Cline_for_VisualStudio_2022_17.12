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
		const userImages = stringArrayValue(request.userImages)
		const userFiles = stringArrayValue(request.userFiles)
		const startInput: any = {
			config: {
				...config,
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

		const result = await core.start(startInput)

		this.activeSessionId = result.sessionId
		return result
	}

	async send(params: unknown) {
		const core = await this.getCore()
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.activeSessionId
		if (!sessionId) {
			throw new Error("No active Cline SDK session. Call sdk.startSession first.")
		}

		return core.send({
			sessionId,
			prompt: stringValue(request.prompt) || "",
			mode: agentMode(request.mode),
			delivery: request.delivery === "queue" || request.delivery === "steer" ? request.delivery : undefined,
			userImages: stringArrayValue(request.userImages),
			userFiles: stringArrayValue(request.userFiles),
		})
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
							return typeof result === "string" ? result : JSON.stringify(result)
						} finally {
							abortSignal?.removeEventListener("abort", abortHandler)
						}
					},
					editor: async (input: { path: string; old_text?: string | null; new_text: string; insert_line?: number | null }, cwd: string) => {
						const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
						const filePath = resolveWorkspacePath(input.path, workspaceRoots, cwd)
						const current = await this.host.workspaceClient.readTextFile({ path: filePath })
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

						await this.host.workspaceClient.writeTextFile({ path: filePath, content: next })
						return `Wrote ${filePath}`
					},
					applyPatch: defaultExecutors.applyPatch,
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

async function importClineSdk(): Promise<ClineSdkModule> {
	const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ClineSdkModule>
	return importEsm("@cline/sdk")
}
