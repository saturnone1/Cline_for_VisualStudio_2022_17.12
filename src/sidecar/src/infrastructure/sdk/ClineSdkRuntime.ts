import fs from "node:fs"
import path from "node:path"
import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { AgentEnginePort, AgentMessageRequest, AgentSessionRequest, AgentStartRequest } from "../../application/ports/AgentEnginePort"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { AgentRuntimeEvent, ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
import { createClineSdkCore } from "./ClineSdkCoreFactory"
import { ClineSdkMcpAdapter } from "./ClineSdkMcpAdapter"
import { ClineSdkProviderAdapter } from "./ClineSdkProviderAdapter"
import { ClineSdkSessionAdapter, type ClineSdkCore } from "./ClineSdkSessionAdapter"
export type ClineSdkStatus = {
	mode: "sdk"
	packageName: string
	packageVersion: string | null
	started: boolean
	activeSessionId: string | null
	runtimeAddress?: string
	lastError?: string
}

export class ClineSdkRuntime implements AgentEnginePort {
	private core: ClineSdkCore | null = null
	private starting: Promise<ClineSdkCore> | null = null
	private readonly mcp: ClineSdkMcpAdapter
	private readonly providers = new ClineSdkProviderAdapter()
	private readonly sessions: ClineSdkSessionAdapter
	private activeSessionId: string | null = null
	private lastError: string | undefined

	constructor(
		private readonly host: HostProviderPort,
		private readonly sidecarRoot: string,
		private readonly onCoreEvent?: (event: AgentRuntimeEvent) => void,
		private readonly onToolApproval?: (request: ApprovalRequestedEvent) => Promise<ToolApprovalResult>,
		private readonly onAskQuestion?: (question: string, options: string[]) => Promise<AskQuestionResult>,
		private readonly isAutomationEnabled?: () => boolean,
	) {
		this.mcp = new ClineSdkMcpAdapter(host, () => this.readSdkVersion(), (level, message, metadata) => this.logSdkMessage(level, message, metadata))
		this.sessions = new ClineSdkSessionAdapter({
			getCore: () => this.getCore(),
			getCurrentCore: () => this.core,
			getActiveSessionId: () => this.activeSessionId,
			setActiveSessionId: (sessionId) => { this.activeSessionId = sessionId },
			getWorkspacePaths: () => this.host.workspaceClient.getWorkspacePaths({}),
			createExtraTools: () => this.mcp.createExtraToolsForSession(),
			getStatus: () => this.status,
		})
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

	async getProviderConfigFields(providerId: string): Promise<unknown> {
		return this.providers.getConfigFields(providerId)
	}

	markSessionInactive(sessionId?: string) {
		this.sessions.markInactive(sessionId)
	}

	async activateSession(sessionId: string) {
		return this.sessions.activate(sessionId)
	}

	async ensureStarted() {
		const core = await this.getCore()
		const history = await core.listHistory({ limit: 5 }).catch(() => [])
		return {
			...this.status,
			historyCount: Array.isArray(history) ? history.length : 0,
		}
	}

	async startSession(request: AgentStartRequest) {
		return this.sessions.start(request)
	}

	async send(request: AgentMessageRequest) {
		return this.sessions.send(request)
	}

	async stop(request: AgentSessionRequest) {
		return this.sessions.stop(request)
	}

	async abort(request: AgentSessionRequest) {
		return this.sessions.abort(request)
	}

	async listHistory(params: unknown) {
		return this.sessions.listHistory(params)
	}

	async getSession(params: unknown) {
		return this.sessions.getSession(params)
	}

	async readMessages(params: unknown) {
		return this.sessions.readMessages(params)
	}

	async deleteSession(params: unknown) {
		return this.sessions.deleteSession(params)
	}

	async updateSession(params: unknown) {
		return this.sessions.updateSession(params)
	}

	async getUsage(params: unknown) {
		return this.sessions.getUsage(params)
	}

	async restore(params: unknown) {
		return this.sessions.restore(params)
	}

	async listSettings(params: unknown) {
		return this.sessions.listSettings(params)
	}

	async toggleSetting(params: unknown) {
		return this.sessions.toggleSetting(params)
	}

	async getMcpSettingsPath() { return this.mcp.getMcpSettingsPath() }
	async listMcpServers() { return this.mcp.listMcpServers() }
	async getMcpServersResponse() { return this.mcp.getMcpServersResponse() }
	async authenticateMcpServer(params: unknown) { return this.mcp.authenticateMcpServer(params) }
	async addRemoteMcpServer(params: unknown) { return this.mcp.addRemoteMcpServer(params) }
	async setMcpServerDisabled(params: unknown) { return this.mcp.setMcpServerDisabled(params) }
	async updateMcpTimeout(params: unknown) { return this.mcp.updateMcpTimeout(params) }
	async deleteMcpServer(params: unknown) { return this.mcp.deleteMcpServer(params) }
	async restartMcpServer(params: unknown) { return this.mcp.restartMcpServer(params) }
	async toggleMcpToolAutoApprove(params: unknown) { return this.mcp.toggleMcpToolAutoApprove(params) }

	async dispose() {
		const core = this.core
		this.core = null
		this.starting = null
		this.activeSessionId = null
		if (core) {
			await core.dispose("Visual Studio sidecar disconnected")
		}
		await this.mcp.dispose()
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
		return createClineSdkCore({
			host: this.host,
			ensureMcpStarted: () => this.mcp.ensureStarted(),
			getActiveSessionId: () => this.activeSessionId,
			onEvent: this.onCoreEvent,
			onToolApproval: this.onToolApproval,
			onAskQuestion: this.onAskQuestion,
			isAutomationEnabled: this.isAutomationEnabled,
			log: (level, message, metadata) => this.logSdkMessage(level, message, metadata),
		})
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
