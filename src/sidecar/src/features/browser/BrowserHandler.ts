import type { BrowserAutomationPort } from "../../application/ports/BrowserAutomationPort"
import { normalizeBrowserActionName, normalizeBrowserDebugHost, normalizeBrowserViewport, screenshotByteLength, type BrowserAction } from "./BrowserPolicy"

export type BrowserSettings = Readonly<{
	remoteBrowserEnabled: boolean
	remoteBrowserHost: string
	chromeExecutablePath: string
	disableToolUse: boolean
	viewport: unknown
	webFetchEnabled: boolean
	webFetchDisabledReason: string
}>

type BrowserSessionRecord = {
	sessionId: string
	host: string
	tabId?: string
	url?: string
	title?: string
	createdAt: number
	lastActionAt: number
	lastActionId?: string
	lastPhase?: string
	reconnectReason?: string
}

export class BrowserHandler {
	private readonly sessions = new Map<string, BrowserSessionRecord>()

	constructor(
		private readonly automation: BrowserAutomationPort,
		private readonly createId: () => string,
		private readonly sessionTtlMs = 30 * 60 * 1000,
	) {}

	getDetectedPath(settings: BrowserSettings) {
		return { path: this.automation.resolveExecutablePath(settings.chromeExecutablePath), isBundled: false }
	}

	async getConnectionInfo(settings: BrowserSettings) {
		const debugInfo = settings.remoteBrowserEnabled ? await this.automation.fetchDebugInfo(settings.remoteBrowserHost) : null
		const executablePath = this.automation.resolveExecutablePath(settings.chromeExecutablePath)
		return {
			isConnected: settings.remoteBrowserEnabled ? Boolean(debugInfo?.success) : Boolean(executablePath),
			isRemote: settings.remoteBrowserEnabled,
			host: settings.remoteBrowserEnabled ? normalizeBrowserDebugHost(settings.remoteBrowserHost) : "",
			path: settings.remoteBrowserEnabled ? "" : executablePath,
			browser: debugInfo?.browser || "",
			protocolVersion: debugInfo?.protocolVersion || "",
			tabCount: debugInfo?.tabCount ?? 0,
			activeTabTitle: debugInfo?.activeTabTitle || "",
			activeTabUrl: debugInfo?.activeTabUrl || "",
			error: debugInfo?.error || "",
			...browserCapabilityState(settings),
		}
	}

	async testConnection(host: string, settings: BrowserSettings) {
		const debugInfo = await this.automation.fetchDebugInfo(host)
		const success = Boolean(debugInfo.success)
		return {
			success,
			message: success ? `Browser connection successful.${debugInfo.browser ? ` ${debugInfo.browser}` : ""}` : debugInfo.error || "Unable to reach the configured browser host.",
			host: debugInfo.host || normalizeBrowserDebugHost(host),
			browser: debugInfo.browser || "",
			protocolVersion: debugInfo.protocolVersion || "",
			tabCount: debugInfo.tabCount ?? 0,
			activeTabTitle: debugInfo.activeTabTitle || "",
			activeTabUrl: debugInfo.activeTabUrl || "",
			...browserCapabilityState(settings),
		}
	}

	async discover(settings: BrowserSettings) {
		if (settings.remoteBrowserEnabled) {
			const debugInfo = await this.automation.fetchDebugInfo(settings.remoteBrowserHost)
			const success = Boolean(debugInfo.success)
			return {
				success,
				message: success ? `Browser connection successful.${debugInfo.browser ? ` ${debugInfo.browser}` : ""}` : debugInfo.error || "Unable to reach the configured browser host.",
				host: normalizeBrowserDebugHost(settings.remoteBrowserHost),
				browser: debugInfo.browser || "",
				protocolVersion: debugInfo.protocolVersion || "",
				tabCount: debugInfo.tabCount ?? 0,
				activeTabTitle: debugInfo.activeTabTitle || "",
				activeTabUrl: debugInfo.activeTabUrl || "",
				...browserCapabilityState(settings),
			}
		}
		const detectedPath = this.automation.resolveExecutablePath(settings.chromeExecutablePath)
		return {
			success: Boolean(detectedPath),
			message: detectedPath ? `Detected browser at ${detectedPath}` : "No local Chrome or Edge executable could be found.",
			path: detectedPath,
			...browserCapabilityState(settings),
		}
	}

	async listTabs(settings: BrowserSettings) {
		const config = adapterConfig(settings)
		return config.disabled ? { success: false, tabs: [], error: disabledMessage } : this.automation.listTabs(config.host)
	}

	async captureScreenshot(params: unknown, settings: BrowserSettings) {
		const config = adapterConfig(settings)
		if (config.disabled) return { success: false, error: disabledMessage }
		const request = asRecord(params)
		return this.runWithSession(config.host, { action: "screenshot", tabId: getString(request, "tabId"), viewport: config.viewport })
	}

	async performAction(params: unknown, settings: BrowserSettings) {
		const config = adapterConfig(settings)
		if (config.disabled) return { success: false, status: "error", error: disabledMessage }
		const input = asRecord(params)
		return this.runWithSession(config.host, {
			action: normalizeBrowserActionName(getString(input, "action") || getString(input, "name") || "navigate"),
			url: getString(input, "url") || getString(input, "value"),
			tabId: getString(input, "tabId"),
			browserSessionId: getString(input, "browserSessionId"),
			coordinate: getString(input, "coordinate"),
			text: getString(input, "text"),
			viewport: config.viewport,
		})
	}

	private async runWithSession(host: string, request: BrowserAction) {
		this.pruneSessions()
		const normalizedHost = normalizeBrowserDebugHost(host)
		const existing = (request.browserSessionId && this.sessions.get(request.browserSessionId)) || Array.from(this.sessions.values()).find((session) => session.host === normalizedHost && (!request.tabId || session.tabId === request.tabId))
		const sessionId = existing?.sessionId || `browser-${this.createId()}`
		const actionId = `browser-action-${this.createId()}`
		const session = existing || { sessionId, host: normalizedHost, createdAt: Date.now(), lastActionAt: Date.now() }
		session.lastActionId = actionId
		session.lastActionAt = Date.now()
		session.lastPhase = "starting"
		this.sessions.set(sessionId, session)
		const phases: Array<Record<string, unknown>> = []
		const result = await this.automation.runAction(normalizedHost, {
			...request,
			tabId: request.tabId || session.tabId,
			browserSessionId: sessionId,
			browserActionId: actionId,
			onPhase: (phase) => {
				session.lastPhase = getString(phase, "phase") || session.lastPhase
				session.lastActionAt = Date.now()
				phases.push({ ...phase, browserSessionId: sessionId, browserActionId: actionId })
			},
		})
		const record = asRecord(result)
		session.tabId = getString(record, "tabId") || session.tabId
		session.url = getString(record, "currentUrl") || getString(record, "url") || session.url
		session.title = getString(record, "title") || session.title
		session.reconnectReason = getString(record, "reconnectReason") || session.reconnectReason
		session.lastPhase = getString(record, "status") || session.lastPhase
		session.lastActionAt = Date.now()
		return { ...record, browserSessionId: sessionId, browserActionId: actionId, phases, tabId: session.tabId || getString(record, "tabId"), currentUrl: session.url || getString(record, "currentUrl"), title: session.title || getString(record, "title"), screenshotBytes: screenshotByteLength(getString(record, "screenshot")) }
	}

	private pruneSessions() {
		const now = Date.now()
		for (const [sessionId, session] of this.sessions) if (now - session.lastActionAt > this.sessionTtlMs) this.sessions.delete(sessionId)
	}
}

const disabledMessage = "Browser tool usage is disabled in Visual Studio settings."
function adapterConfig(settings: BrowserSettings) { return { host: normalizeBrowserDebugHost(settings.remoteBrowserHost || "http://localhost:9222"), viewport: normalizeBrowserViewport(settings.viewport), disabled: settings.disableToolUse } }
function browserCapabilityState(settings: BrowserSettings) { return { webFetchEnabled: settings.webFetchEnabled, webFetchDisabledReason: settings.webFetchDisabledReason, browserToolUseDisabled: settings.disableToolUse } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(record: Record<string, unknown>, key: string) { return typeof record[key] === "string" ? record[key] as string : "" }
