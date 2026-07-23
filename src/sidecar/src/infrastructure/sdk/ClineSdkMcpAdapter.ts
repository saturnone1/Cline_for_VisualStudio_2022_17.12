import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import { readPositiveIntEnv } from "./SdkToolSupport"
import { callMcpListMethod, getArrayProperty, isToolAutoApproved, normalizeMcpPrompts, normalizeMcpResources, normalizeMcpResourceTemplates, toDisplayMcpConfig, toProtoMcpStatus } from "./McpProjection"
import { ClineSdkMcpSettingsStore } from "./ClineSdkMcpSettingsStore"
import { MCP_AUTO_APPROVE_MARKER } from "./SdkSessionRequestBuilder"

type ClineSdkModule = typeof import("@cline/sdk")
type McpManagerInstance = InstanceType<ClineSdkModule["InMemoryMcpManager"]>
type McpOperation = "connecting" | "restarting" | "deleting" | "authenticating" | "toggling"

export class ClineSdkMcpAdapter {
	private manager: McpManagerInstance | null = null
	private starting: Promise<McpManagerInstance> | null = null
	private lifecycleGeneration = 0
	private disposed = false
	private readonly settings = new ClineSdkMcpSettingsStore()
	private readonly operationStates = new Map<string, McpOperation>()
	private readonly operationErrors = new Map<string, string>()
	private readonly sessionToolErrors = new Map<string, string>()

	constructor(
		private readonly host: HostProviderPort,
		private readonly readSdkVersion: () => string | null,
		private readonly log: (level: string, message: string, metadata?: unknown) => void,
		private readonly managerFactory?: () => Promise<McpManagerInstance>,
	) {}

	async ensureStarted() { await this.ensureMcpManager() }

	async getMcpSettingsPath() {
		const sdk = await importClineSdk()
		return this.settings.resolvePath(sdk)
	}

	async listMcpServers() {
		const sdk = await importClineSdk()
		const manager = await this.ensureMcpManager()
		await this.registerMcpServersFromSettings(sdk, manager)
		const settings = this.settings.load(sdk)
		const registrations = sdk.resolveMcpServerRegistrations({ filePath: this.settings.resolvePath(sdk) })
		const snapshots = new Map(manager.listServers().map((server) => [server.name, server]))
		const oauthStatuses = new Map(sdk.listMcpServerOAuthStatuses({ filePath: this.settings.resolvePath(sdk) }).map((status) => [status.serverName, status]))

		const servers = []
		for (const registration of registrations) {
			const snapshot = snapshots.get(registration.name)
			const config = asRecord(settings.mcpServers?.[registration.name])
			const timeout = numberValue(config.timeout) || numberValue(asRecord(registration.metadata).timeout)
			const disabled = registration.disabled === true || config.disabled === true
			let tools: Array<Record<string, unknown>> = []
			const lifecycleState = this.operationStates.get(registration.name)
			const lifecycleError = this.operationErrors.get(registration.name)
			const sessionToolError = this.sessionToolErrors.get(registration.name)
			let error = lifecycleError || sessionToolError || snapshot?.lastError || ""
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
			if (!disabled && sessionToolError && !lifecycleState) {
				status = "disconnected"
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
		const filePath = this.settings.resolvePath(sdk)

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
		await this.settings.mutate(sdk, (settings) => {
			settings.mcpServers[serverName] = {
				transport: {
					type: transportType,
					url: serverUrl,
				},
				disabled: false,
				timeout: readPositiveIntEnv("VSCLINE_MCP_TIMEOUT_SECONDS", 60),
			} as any
		})
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
			await this.settings.mutate(sdk, (settings) => {
				const current = asRecord(settings.mcpServers[name])
				if (Object.keys(current).length === 0) {
					throw new Error(`MCP server not found: ${name}`)
				}
				settings.mcpServers[name] = { ...current, disabled } as any
			})
			const manager = await this.ensureMcpManager()
			await manager.setServerDisabled(name, disabled)
			this.sessionToolErrors.delete(name)
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
		await this.settings.mutate(sdk, (settings) => {
			const current = asRecord(settings.mcpServers[name])
			if (Object.keys(current).length === 0) {
				throw new Error(`MCP server not found: ${name}`)
			}
			settings.mcpServers[name] = { ...current, timeout } as any
		})
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
			await this.settings.mutate(sdk, (settings) => {
				delete settings.mcpServers[name]
			})
			const manager = await this.ensureMcpManager()
			await manager.unregisterServer(name)
			this.sessionToolErrors.delete(name)
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
			await manager.disconnectServer(name)
			await manager.connectServer(name)
			await manager.refreshTools(name)
			this.sessionToolErrors.delete(name)
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
		await this.settings.mutate(sdk, (settings) => {
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
		})
		return this.getMcpServersResponse()
	}

	private async withMcpOperation<T>(
		serverName: string,
		operation: "connecting" | "restarting" | "deleting" | "authenticating" | "toggling",
		action: () => Promise<T>,
	) {
		this.operationStates.set(serverName, operation)
		this.operationErrors.delete(serverName)
		try {
			const result = await action()
			this.operationErrors.delete(serverName)
			return result
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.operationErrors.set(serverName, message)
			this.logSdkMessage("warn", `MCP ${operation} failed for ${serverName}`, { error: message })
			throw error
		} finally {
			this.operationStates.delete(serverName)
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

	private async createMcpExtraTools() {
		const sdk = await importClineSdk()
		const manager = await this.ensureMcpManager()
		const settings = this.settings.load(sdk)
		const registrations = sdk.resolveMcpServerRegistrations({ filePath: this.settings.resolvePath(sdk) })
		const tools = []
		for (const registration of registrations) {
			if (registration.disabled) {
				this.sessionToolErrors.delete(registration.name)
				continue
			}
			try {
				const serverConfig = settings.mcpServers[registration.name] || {}
				const createdTools = await sdk.createMcpTools({
					serverName: registration.name,
					provider: manager,
					retryable: false,
				})
				tools.push(
					...createdTools.map((tool) => {
						const record = tool as unknown as Record<string, unknown>
						const generatedName = typeof record.name === "string" ? record.name : ""
						const prefix = `${registration.name}__`
						const configuredName = generatedName.startsWith(prefix) ? generatedName.slice(prefix.length) : generatedName
						return {
							...record,
							[MCP_AUTO_APPROVE_MARKER]: isToolAutoApproved(serverConfig, configuredName),
						}
					}),
				)
				this.sessionToolErrors.delete(registration.name)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				this.sessionToolErrors.set(registration.name, `Connected, but unavailable to the current agent session: ${message}`)
				this.logSdkMessage("warn", `Failed to create MCP tools for ${registration.name}`, {
					error: message,
				})
			}
		}
		return tools.length > 0 ? tools : undefined
	}

	async createExtraToolsForSession() {
		if (process.env.VSCLINE_ENABLE_MCP_EXTRA_TOOLS === "0") {
			return undefined
		}

		return this.createMcpExtraTools()
	}

	private async ensureMcpManager() {
		if (this.disposed) throw new Error("The LIG VS MCP runtime has been disposed.")
		if (this.manager) {
			return this.manager
		}
		if (!this.starting) {
			const generation = this.lifecycleGeneration
			const starting = this.createMcpManager()
				.then(async (manager) => {
					if (this.disposed || generation !== this.lifecycleGeneration) {
						await manager.dispose().catch(() => undefined)
						throw new Error("The LIG VS MCP runtime was disposed during startup.")
					}
					this.manager = manager
					return manager
				})
				.catch((error) => {
					throw error
				})
				.finally(() => {
					if (this.starting === starting) this.starting = null
				})
			this.starting = starting
		}
		return this.starting
	}

	private async createMcpManager() {
		if (this.managerFactory) return this.managerFactory()
		const sdk = await importClineSdk()
		const settingsPath = this.settings.resolvePath(sdk)
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
			await manager.unregisterServer(server.name)
		}
		await this.registerMcpServersFromSettings(sdk, manager)
	}

	private async registerMcpServersFromSettings(sdk: ClineSdkModule, manager: McpManagerInstance) {
		const settingsPath = this.settings.resolvePath(sdk)
		const registrations = sdk.resolveMcpServerRegistrations({ filePath: settingsPath })
		const existing = new Set(manager.listServers().map((server) => server.name))
		for (const registration of registrations) {
			if (!existing.has(registration.name)) {
				await manager.registerServer(registration)
			}
		}
		return registrations
	}

	async dispose() {
		if (this.disposed) return
		this.disposed = true
		this.lifecycleGeneration++
		const manager = this.manager
		const starting = this.starting
		this.manager = null
		this.starting = null
		this.sessionToolErrors.clear()
		if (manager) await manager.dispose().catch(() => undefined)
		await starting?.catch(() => undefined)
	}

	private logSdkMessage(level: string, message: string, metadata?: unknown) { this.log(level, message, metadata) }
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown) { return typeof value === "string" && value.trim().length > 0 ? value : undefined }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function stringArrayValue(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [] }
async function importClineSdk(): Promise<ClineSdkModule> { const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ClineSdkModule>; return importEsm("@cline/sdk") }
