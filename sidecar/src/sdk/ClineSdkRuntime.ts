import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentToolContext } from "@cline/shared"
import type { JsonRpcConnection } from "../ipc/types"
import { VisualStudioHostProvider } from "../host/VisualStudioHostProvider"

type ClineSdkModule = typeof import("@cline/sdk")
type ClineCoreInstance = Awaited<ReturnType<ClineSdkModule["ClineCore"]["create"]>>
type CoreSessionEvent = Parameters<ClineCoreInstance["subscribe"]>[0] extends (event: infer T) => void ? T : unknown
type McpManagerInstance = InstanceType<ClineSdkModule["InMemoryMcpManager"]>
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
	private mcpManager: McpManagerInstance | null = null
	private mcpStarting: Promise<McpManagerInstance> | null = null
	private mcpSettingsPath: string | null = null
	private readonly mcpOperationStates = new Map<string, "connecting" | "restarting" | "deleting" | "authenticating" | "toggling">()
	private readonly mcpOperationErrors = new Map<string, string>()
	private activeSessionId: string | null = null
	private lastError: string | undefined

	constructor(
		connection: JsonRpcConnection,
		private readonly sidecarRoot: string,
		private readonly onCoreEvent?: (event: CoreSessionEvent) => void,
		private readonly onToolApproval?: (request: unknown) => Promise<ToolApprovalResult>,
		private readonly onAskQuestion?: (question: string, options: string[]) => Promise<AskQuestionResult>,
		private readonly isAutomationEnabled?: () => boolean,
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

	async activateSession(sessionId: string) {
		const core = await this.getCore()
		if (!sessionId) {
			this.activeSessionId = null
			return null
		}

		const session = await core.get(sessionId)
		if (session) {
			this.activeSessionId = sessionId
		}
		return session
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
			"You are Cline running inside Visual Studio 2022 through the VsClineAgent wrapper. Commands execute under Windows cmd.exe; when using cmd built-ins such as dir, type, copy, or del, use backslashes for paths or quote absolute paths."
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
				extraTools: await this.createMcpExtraTools(),
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

	async getMcpSettingsPath() {
		const sdk = await importClineSdk()
		return this.resolveMcpSettingsPath(sdk)
	}

	async listMcpServers() {
		const sdk = await importClineSdk()
		const manager = await this.ensureMcpManager()
		await this.registerMcpServersFromSettings(sdk, manager)
		const settings = this.loadMcpSettings(sdk)
		const registrations = sdk.resolveMcpServerRegistrations({ filePath: this.resolveMcpSettingsPath(sdk) })
		const snapshots = new Map(manager.listServers().map((server) => [server.name, server]))
		const oauthStatuses = new Map(sdk.listMcpServerOAuthStatuses({ filePath: this.resolveMcpSettingsPath(sdk) }).map((status) => [status.serverName, status]))

		const servers = []
		for (const registration of registrations) {
			const snapshot = snapshots.get(registration.name)
			const config = asRecord(settings.mcpServers?.[registration.name])
			const timeout = numberValue(config.timeout) || numberValue(asRecord(registration.metadata).timeout)
			const disabled = registration.disabled === true || config.disabled === true
			let tools: Array<Record<string, unknown>> = []
			const lifecycleState = this.mcpOperationStates.get(registration.name)
			const lifecycleError = this.mcpOperationErrors.get(registration.name)
			let error = lifecycleError || snapshot?.lastError || ""
			let status = disabled ? "disconnected" : snapshot?.status || "disconnected"
			let resources: Array<Record<string, unknown>> = []
			let resourceTemplates: Array<Record<string, unknown>> = []
			let prompts: Array<Record<string, unknown>> = []

			if (lifecycleState && lifecycleState !== "deleting") {
				status = "connecting"
			}

			if (!disabled && !lifecycleState) {
				try {
					const listedTools = await manager.listTools(registration.name)
					tools = listedTools.map((tool) => ({
						name: tool.name,
						description: tool.description || "",
						inputSchema: JSON.stringify(tool.inputSchema || {}),
						autoApprove: isToolAutoApproved(config, tool.name),
					}))
					status = "connected"
				} catch (toolError) {
					error = toolError instanceof Error ? toolError.message : String(toolError)
					status = "disconnected"
				}
			}
			if (!disabled && status === "connected") {
				const serverMetadata = asRecord(snapshot?.metadata)
				resources = await this.listMcpResourcesBestEffort(manager, registration.name, snapshot, serverMetadata)
				resourceTemplates = await this.listMcpResourceTemplatesBestEffort(manager, registration.name, snapshot, serverMetadata)
				prompts = await this.listMcpPromptsBestEffort(manager, registration.name, snapshot, serverMetadata)
			}

			const oauth = oauthStatuses.get(registration.name)
			servers.push({
				name: registration.name,
				config: JSON.stringify(toDisplayMcpConfig(registration as unknown as Record<string, unknown>, config)),
				status: toProtoMcpStatus(status),
				error,
				tools,
				resources,
				resourceTemplates,
				prompts,
				disabled,
				timeout,
				oauthRequired: oauth?.oauthSupported === true && oauth.oauthConfigured !== true,
				oauthAuthStatus:
					lifecycleState === "authenticating"
						? "pending"
						: oauth?.oauthConfigured
							? "authenticated"
							: oauth?.oauthSupported
								? "unauthenticated"
								: undefined,
			})
		}

		return servers
	}

	async getMcpServersResponse() {
		const mcpServers = await this.listMcpServers()
		return { mcpServers, servers: mcpServers }
	}

	async authenticateMcpServer(params: unknown) {
		const request = asRecord(params)
		const name = stringValue(request.serverName) || stringValue(request.name) || stringValue(request.value)
		if (!name) {
			throw new Error("MCP server name is required.")
		}

		const sdk = await importClineSdk()
		const filePath = this.resolveMcpSettingsPath(sdk)
		this.ensureMcpSettingsFile(filePath)

		await this.withMcpOperation(name, "authenticating", async () => {
			if (typeof sdk.authorizeMcpServerOAuth !== "function") {
				throw new Error("MCP OAuth is unsupported by the bundled Cline SDK.")
			}
			await sdk.authorizeMcpServerOAuth({
				serverName: name,
				filePath,
				clientName: "VsClineAgent",
				clientVersion: this.readSdkVersion() || "0.0.0",
				callbackHost: "127.0.0.1",
				timeoutMs: readPositiveIntEnv("VSCLINE_MCP_OAUTH_TIMEOUT_MS", 300000),
				openUrl: async (url: string) => {
					this.logSdkMessage("info", "Opening MCP OAuth URL", { serverName: name })
					await this.host.envClient.openExternal({ value: url })
				},
				onServerListening: (info: unknown) => {
					this.logSdkMessage("info", "MCP OAuth callback server listening", info)
				},
				onServerClose: (info: unknown) => {
					this.logSdkMessage("info", "MCP OAuth callback server closed", info)
				},
			})

			await this.reloadMcpServers()
		})
		return this.getMcpServersResponse()
	}

	async addRemoteMcpServer(params: unknown) {
		const request = asRecord(params)
		const serverName = stringValue(request.serverName) || stringValue(request.name)
		const serverUrl = stringValue(request.serverUrl) || stringValue(request.url)
		const transportType = stringValue(request.transportType) === "sse" ? "sse" : "streamableHttp"
		if (!serverName) {
			throw new Error("MCP server name is required.")
		}
		if (!serverUrl) {
			throw new Error("MCP server URL is required.")
		}

		new URL(serverUrl)
		const sdk = await importClineSdk()
		const settings = this.loadMcpSettings(sdk)
		settings.mcpServers[serverName] = {
			transport: {
				type: transportType,
				url: serverUrl,
			},
			disabled: false,
			timeout: readPositiveIntEnv("VSCLINE_MCP_TIMEOUT_SECONDS", 60),
		} as any
		await this.saveMcpSettings(sdk, settings)
		await this.withMcpOperation(serverName, "connecting", async () => {
			await this.reloadMcpServers()
		})
		return this.getMcpServersResponse()
	}

	async setMcpServerDisabled(params: unknown) {
		const request = asRecord(params)
		const name = stringValue(request.serverName) || stringValue(request.name) || stringValue(request.value)
		if (!name) {
			throw new Error("MCP server name is required.")
		}
		const disabled = request.disabled === true
		const sdk = await importClineSdk()
		await this.withMcpOperation(name, "toggling", async () => {
			sdk.setMcpServerDisabled({ filePath: this.resolveMcpSettingsPath(sdk), name, disabled })
			const manager = await this.ensureMcpManager()
			await manager.setServerDisabled(name, disabled).catch(() => undefined)
			await this.reloadMcpServers()
		})
		return this.getMcpServersResponse()
	}

	async updateMcpTimeout(params: unknown) {
		const request = asRecord(params)
		const name = stringValue(request.serverName) || stringValue(request.name) || stringValue(request.value)
		const timeout = numberValue(request.timeout)
		if (!name) {
			throw new Error("MCP server name is required.")
		}
		if (!timeout || timeout <= 0) {
			throw new Error("MCP timeout must be a positive number of seconds.")
		}

		const sdk = await importClineSdk()
		const settings = this.loadMcpSettings(sdk)
		const current = asRecord(settings.mcpServers[name])
		if (Object.keys(current).length === 0) {
			throw new Error(`MCP server not found: ${name}`)
		}
		settings.mcpServers[name] = { ...current, timeout } as any
		await this.saveMcpSettings(sdk, settings)
		await this.reloadMcpServers()
		return this.getMcpServersResponse()
	}

	async deleteMcpServer(params: unknown) {
		const request = asRecord(params)
		const name = stringValue(request.serverName) || stringValue(request.name) || stringValue(request.value)
		if (!name) {
			throw new Error("MCP server name is required.")
		}
		await this.withMcpOperation(name, "deleting", async () => {
			const sdk = await importClineSdk()
			const settings = this.loadMcpSettings(sdk)
			delete settings.mcpServers[name]
			await this.saveMcpSettings(sdk, settings)
			const manager = await this.ensureMcpManager()
			await manager.unregisterServer(name).catch(() => undefined)
			await this.reloadMcpServers()
		})
		return this.getMcpServersResponse()
	}

	async restartMcpServer(params: unknown) {
		const request = asRecord(params)
		const name = stringValue(request.serverName) || stringValue(request.name) || stringValue(request.value)
		if (!name) {
			throw new Error("MCP server name is required.")
		}
		await this.withMcpOperation(name, "restarting", async () => {
			const manager = await this.ensureMcpManager()
			await this.reloadMcpServers()
			await manager.disconnectServer(name).catch(() => undefined)
			await manager.connectServer(name).catch(() => undefined)
			await manager.refreshTools(name).catch(() => undefined)
		})
		return this.getMcpServersResponse()
	}

	async toggleMcpToolAutoApprove(params: unknown) {
		const request = asRecord(params)
		const name = stringValue(request.serverName) || stringValue(request.name)
		const toolNames = stringArrayValue(request.toolNames)
		const autoApprove = request.autoApprove === true
		if (!name) {
			throw new Error("MCP server name is required.")
		}

		const sdk = await importClineSdk()
		const settings = this.loadMcpSettings(sdk)
		const current = asRecord(settings.mcpServers[name])
		if (Object.keys(current).length === 0) {
			throw new Error(`MCP server not found: ${name}`)
		}
		const metadata = asRecord(current.metadata)
		const autoApproveTools = new Set(stringArrayValue(metadata.autoApproveTools))
		for (const toolName of toolNames) {
			if (autoApprove) {
				autoApproveTools.add(toolName)
			} else {
				autoApproveTools.delete(toolName)
			}
		}
		settings.mcpServers[name] = {
			...current,
			metadata: {
				...metadata,
				autoApproveTools: [...autoApproveTools],
			},
		} as any
		await this.saveMcpSettings(sdk, settings)
		return this.getMcpServersResponse()
	}

	private async withMcpOperation<T>(
		serverName: string,
		operation: "connecting" | "restarting" | "deleting" | "authenticating" | "toggling",
		action: () => Promise<T>,
	) {
		this.mcpOperationStates.set(serverName, operation)
		this.mcpOperationErrors.delete(serverName)
		try {
			const result = await action()
			this.mcpOperationErrors.delete(serverName)
			return result
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.mcpOperationErrors.set(serverName, message)
			this.logSdkMessage("warn", `MCP ${operation} failed for ${serverName}`, { error: message })
			throw error
		} finally {
			this.mcpOperationStates.delete(serverName)
		}
	}

	private async listMcpResourcesBestEffort(
		manager: McpManagerInstance,
		serverName: string,
		snapshot: unknown,
		metadata: Record<string, unknown>,
	) {
		const listed = await callMcpListMethod(manager, serverName, ["listResources", "getResources", "refreshResources", "listServerResources"])
		return normalizeMcpResources(listed || getArrayProperty(snapshot, "resources") || getArrayProperty(metadata, "resources"))
	}

	private async listMcpResourceTemplatesBestEffort(
		manager: McpManagerInstance,
		serverName: string,
		snapshot: unknown,
		metadata: Record<string, unknown>,
	) {
		const listed = await callMcpListMethod(manager, serverName, [
			"listResourceTemplates",
			"getResourceTemplates",
			"refreshResourceTemplates",
			"listServerResourceTemplates",
		])
		return normalizeMcpResourceTemplates(
			listed || getArrayProperty(snapshot, "resourceTemplates") || getArrayProperty(metadata, "resourceTemplates"),
		)
	}

	private async listMcpPromptsBestEffort(
		manager: McpManagerInstance,
		serverName: string,
		snapshot: unknown,
		metadata: Record<string, unknown>,
	) {
		const listed = await callMcpListMethod(manager, serverName, ["listPrompts", "getPrompts", "refreshPrompts", "listServerPrompts"])
		return normalizeMcpPrompts(listed || getArrayProperty(snapshot, "prompts") || getArrayProperty(metadata, "prompts"))
	}

	async dispose() {
		const core = this.core
		const mcpManager = this.mcpManager
		this.core = null
		this.starting = null
		this.mcpManager = null
		this.mcpStarting = null
		this.activeSessionId = null
		if (core) {
			await core.dispose("Visual Studio sidecar disconnected")
		}
		if (mcpManager) {
			await mcpManager.dispose().catch(() => undefined)
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
		ensureUsableHomeEnvironment()
		const sdk = await importClineSdk()
		await this.ensureMcpManager()
		const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({}).catch(() => [] as string[])
		const workspaceRoot = workspaceRoots[0] || process.cwd()
		const automationEnabled = this.isAutomationEnabled?.() === true || process.env.VSCLINE_ENABLE_AUTOMATION === "1"
		const automation = automationEnabled
			? {
					cronScope: "workspace" as const,
					workspaceRoot,
					cronSpecsDir: path.join(workspaceRoot, ".cline", "cron"),
					autoStart: true,
				}
			: undefined
		const defaultExecutors = sdk.createDefaultExecutors({
			applyPatch: { restrictToCwd: true },
		})
		const core = await sdk.ClineCore.create({
			clientName: "VsClineAgent",
			backendMode: "local",
			...(automation ? { automation } : {}),
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
								? normalizeCommandForWindows(command)
								: normalizeCommandForWindows([command.command, ...(command.args || []).map(normalizeCommandArgumentForWindows)].filter(Boolean).join(" "))
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
								timeoutSeconds: readPositiveIntEnv("VSCLINE_COMMAND_TIMEOUT_SECONDS", 120),
							})
							if (abortSignal?.aborted) {
								throw new Error("Command was cancelled.")
							}
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
						return fetchWebContentForSdk(url, prompt, toolContext)
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

	private async createMcpExtraTools() {
		const sdk = await importClineSdk()
		const manager = await this.ensureMcpManager()
		const registrations = sdk.resolveMcpServerRegistrations({ filePath: this.resolveMcpSettingsPath(sdk) })
		const tools = []
		for (const registration of registrations) {
			if (registration.disabled) {
				continue
			}
			try {
				tools.push(
					...(await sdk.createMcpTools({
						serverName: registration.name,
						provider: manager,
					})),
				)
			} catch (error) {
				this.logSdkMessage("warn", `Failed to create MCP tools for ${registration.name}`, {
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		return tools.length > 0 ? tools : undefined
	}

	private async ensureMcpManager() {
		if (this.mcpManager) {
			return this.mcpManager
		}
		if (!this.mcpStarting) {
			this.mcpStarting = this.createMcpManager()
				.then((manager) => {
					this.mcpManager = manager
					return manager
				})
				.catch((error) => {
					this.mcpStarting = null
					throw error
				})
		}
		return this.mcpStarting
	}

	private async createMcpManager() {
		const sdk = await importClineSdk()
		const settingsPath = this.resolveMcpSettingsPath(sdk)
		this.ensureMcpSettingsFile(settingsPath)
		const manager = new sdk.InMemoryMcpManager({
			clientFactory: sdk.createDefaultMcpServerClientFactory({
				settingsPath,
				clientName: "VsClineAgent",
				clientVersion: this.readSdkVersion() || "0.0.0",
			}),
		})
		await this.registerMcpServersFromSettings(sdk, manager)
		return manager
	}

	private async reloadMcpServers() {
		const sdk = await importClineSdk()
		const manager = await this.ensureMcpManager()
		for (const server of manager.listServers()) {
			await manager.unregisterServer(server.name).catch(() => undefined)
		}
		await this.registerMcpServersFromSettings(sdk, manager)
	}

	private async registerMcpServersFromSettings(sdk: ClineSdkModule, manager: McpManagerInstance) {
		const settingsPath = this.resolveMcpSettingsPath(sdk)
		this.ensureMcpSettingsFile(settingsPath)
		const registrations = sdk.resolveMcpServerRegistrations({ filePath: settingsPath })
		const existing = new Set(manager.listServers().map((server) => server.name))
		for (const registration of registrations) {
			if (!existing.has(registration.name)) {
				await manager.registerServer(registration)
			}
		}
		return registrations
	}

	private resolveMcpSettingsPath(sdk: ClineSdkModule) {
		if (!this.mcpSettingsPath) {
			this.mcpSettingsPath = sdk.resolveDefaultMcpSettingsPath()
		}
		this.ensureMcpSettingsFile(this.mcpSettingsPath)
		return this.mcpSettingsPath
	}

	private loadMcpSettings(sdk: ClineSdkModule) {
		const filePath = this.resolveMcpSettingsPath(sdk)
		this.ensureMcpSettingsFile(filePath)
		const settings = sdk.loadMcpSettingsFile({ filePath }) as { mcpServers: Record<string, Record<string, unknown>> }
		settings.mcpServers = asRecord(settings.mcpServers) as Record<string, Record<string, unknown>>
		return settings
	}

	private async saveMcpSettings(sdk: ClineSdkModule, settings: { mcpServers: Record<string, unknown> }) {
		const filePath = this.resolveMcpSettingsPath(sdk)
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
		await fs.promises.writeFile(filePath, `${JSON.stringify({ mcpServers: settings.mcpServers || {} }, null, 2)}\n`, "utf8")
	}

	private ensureMcpSettingsFile(filePath: string) {
		if (fs.existsSync(filePath)) {
			return
		}
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(filePath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8")
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
	const backgroundNote =
		record.background === true
			? `Command is still running in the Visual Studio terminal session (${stringValue(record.terminalId) || "terminal"}). Use terminal state/output if more output is needed.`
			: undefined
	return JSON.stringify({
		...record,
		stdout: stdout === undefined ? backgroundNote : truncateText([backgroundNote, stdout].filter(Boolean).join("\n"), limit),
		stderr: stderr === undefined ? undefined : truncateText(stderr, Math.min(limit, 8000)),
	})
}

function normalizeCommandForWindows(command: string) {
	if (process.platform !== "win32" || !command) {
		return command
	}

	return command.replace(/(^|\s)(?!\/)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.()[\]{}$@+-]+)+)/g, (_match, prefix: string, candidate: string) => {
		if (candidate.includes("://")) {
			return `${prefix}${candidate}`
		}
		return `${prefix}${candidate.replace(/\//g, "\\")}`
	})
}

function normalizeCommandArgumentForWindows(argument: string) {
	if (process.platform !== "win32" || !argument || argument.startsWith("/") || argument.includes("://")) {
		return argument
	}
	return argument.includes("/") ? argument.replace(/\//g, "\\") : argument
}

function truncateText(value: string, maxChars: number) {
	if (value.length <= maxChars) {
		return value
	}

	return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`
}

async function fetchWebContentForSdk(url: string, prompt: string, context?: AgentToolContext) {
	if (process.env.VSCLINE_ENABLE_WEB_FETCH !== "1") {
		throw new Error("fetch_web_content is disabled for air-gap mode. Set VSCLINE_ENABLE_WEB_FETCH=1 to enable explicit web fetching.")
	}
	const normalizedUrl = normalizeHttpUrl(url)
	if (!normalizedUrl) {
		throw new Error(`Invalid URL for fetch_web_content: ${url}`)
	}

	const timeoutMs = readPositiveIntEnv("VSCLINE_WEB_FETCH_TIMEOUT_MS", 15000)
	const maxChars = readPositiveIntEnv("VSCLINE_WEB_FETCH_RESULT_CHARS", 20000)
	const controller = new AbortController()
	const abortSignal = (context as AgentToolContext & { abortSignal?: AbortSignal } | undefined)?.abortSignal
	const abortHandler = () => controller.abort()
	abortSignal?.addEventListener("abort", abortHandler, { once: true })
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(normalizedUrl, {
			signal: controller.signal,
			headers: {
				Accept: "text/html,text/plain,application/json,application/xml;q=0.8,*/*;q=0.4",
				"User-Agent": "LIG-VS/1.0 VisualStudio2022",
			},
		})
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`)
		}

		const contentType = response.headers.get("content-type") || ""
		const raw = await response.text()
		const text = contentType.includes("html") ? htmlToReadableText(raw) : raw
		const header = [
			`URL: ${normalizedUrl}`,
			contentType ? `Content-Type: ${contentType}` : "",
			prompt ? `Prompt: ${prompt}` : "",
		].filter(Boolean).join("\n")
		return truncateText(`${header}\n\n${text.trim()}`, maxChars)
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Web fetch timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
		}
		throw error
	} finally {
		clearTimeout(timer)
		abortSignal?.removeEventListener("abort", abortHandler)
	}
}

function normalizeHttpUrl(value: string) {
	const raw = String(value || "").trim()
	if (!raw) {
		return ""
	}
	try {
		const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : ""
	} catch {
		return ""
	}
}

function htmlToReadableText(html: string) {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
}

function readPositiveIntEnv(name: string, fallback: number) {
	const value = Number.parseInt(process.env[name] || "", 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function stringArrayValue(value: unknown) {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function isToolAutoApproved(serverConfig: Record<string, unknown>, toolName: string) {
	const metadata = asRecord(serverConfig.metadata)
	return stringArrayValue(metadata.autoApproveTools).includes(toolName)
}

async function callMcpListMethod(manager: McpManagerInstance, serverName: string, methodNames: string[]) {
	const source = manager as unknown as Record<string, unknown>
	for (const methodName of methodNames) {
		const method = source[methodName]
		if (typeof method !== "function") {
			continue
		}
		try {
			const result = await method.call(manager, serverName)
			return Array.isArray(result) ? result : undefined
		} catch {
			return undefined
		}
	}
	return undefined
}

function getArrayProperty(source: unknown, propertyName: string) {
	const value = asRecord(source)[propertyName]
	return Array.isArray(value) ? value : undefined
}

function normalizeMcpResources(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value)
		const uri = stringValue(record.uri)
		if (!uri) {
			return []
		}
		return [{
			uri,
			name: stringValue(record.name) || uri,
			mimeType: stringValue(record.mimeType),
			description: stringValue(record.description),
		}]
	})
}

function normalizeMcpResourceTemplates(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value)
		const uriTemplate = stringValue(record.uriTemplate)
		if (!uriTemplate) {
			return []
		}
		return [{
			uriTemplate,
			name: stringValue(record.name) || uriTemplate,
			description: stringValue(record.description),
			mimeType: stringValue(record.mimeType),
		}]
	})
}

function normalizeMcpPrompts(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value)
		const name = stringValue(record.name)
		if (!name) {
			return []
		}
		return [{
			name,
			title: stringValue(record.title),
			description: stringValue(record.description),
			arguments: normalizeMcpPromptArguments(getArrayProperty(record, "arguments")),
		}]
	})
}

function normalizeMcpPromptArguments(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value)
		const name = stringValue(record.name)
		if (!name) {
			return []
		}
		return [{
			name,
			description: stringValue(record.description),
			required: record.required === true,
		}]
	})
}

function toDisplayMcpConfig(registration: Record<string, unknown>, serverConfig: Record<string, unknown>) {
	const transport = asRecord(registration.transport) || asRecord(serverConfig.transport)
	const metadata = asRecord(registration.metadata)
	const timeout = numberValue(serverConfig.timeout) || numberValue(metadata.timeout)
	return {
		...transport,
		...(timeout ? { timeout } : {}),
		...(serverConfig.disabled === true || registration.disabled === true ? { disabled: true } : {}),
	}
}

function toProtoMcpStatus(status: string) {
	switch (status) {
		case "connected":
			return "MCP_SERVER_STATUS_CONNECTED"
		case "connecting":
			return "MCP_SERVER_STATUS_CONNECTING"
		case "disconnected":
		default:
			return "MCP_SERVER_STATUS_DISCONNECTED"
	}
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
	const normalizedInputPath = expandTildePath(inputPath)
	const resolved = path.resolve(path.isAbsolute(normalizedInputPath) ? normalizedInputPath : path.join(base || process.cwd(), normalizedInputPath))
	const allowed = roots.some((root) => isPathInsideOrEqual(resolved, root))
	if (!allowed) {
		throw new Error(`Access denied: path outside Visual Studio workspace: ${inputPath}`)
	}

	return resolved
}

function expandTildePath(inputPath: string) {
	const trimmed = inputPath.trim()
	if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(getUsableHomeDirectory(), trimmed.slice(1))
	}
	return inputPath
}

function ensureUsableHomeEnvironment() {
	const fallbackHome = getFallbackHomeDirectory()
	for (const name of ["HOME", "USERPROFILE"]) {
		const current = process.env[name]
		if (!isUsableHomePath(current)) {
			process.env[name] = fallbackHome
		}
	}
}

function getUsableHomeDirectory() {
	const candidates = [
		process.env.USERPROFILE,
		process.env.HOME,
		os.homedir(),
		getFallbackHomeDirectory(),
	]
	for (const candidate of candidates) {
		if (candidate && isUsableHomePath(candidate)) {
			return path.resolve(candidate)
		}
	}
	return getFallbackHomeDirectory()
}

function getFallbackHomeDirectory() {
	const root = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.tmpdir(), "VsClineAgent")
	const fallbackHome = path.join(root, "VsClineAgent", "home")
	try {
		fs.mkdirSync(fallbackHome, { recursive: true })
	} catch {
		return process.cwd()
	}
	return fallbackHome
}

function isUsableHomePath(value: string | undefined) {
	if (!value || value.trim().length === 0 || hasLiteralTildeSegment(value)) {
		return false
	}
	try {
		const resolved = path.resolve(value)
		fs.mkdirSync(resolved, { recursive: true })
		fs.accessSync(resolved, fs.constants.W_OK)
		return true
	} catch {
		return false
	}
}

function hasLiteralTildeSegment(value: string) {
	return value.split(/[\\/]+/).some((part) => part === "~")
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
