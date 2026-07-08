import fs from "node:fs"
import childProcess from "node:child_process"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { VisualStudioHostProvider } from "../host/VisualStudioHostProvider"
import { sendHostRequest, type JsonRpcConnection } from "../ipc/types"
import type { AskQuestionResult, ClineSdkRuntime, ToolApprovalResult } from "../sdk/ClineSdkRuntime"
import { logInteraction } from "../diagnostics/InteractionLog"

const execFile = promisify(childProcess.execFile)

export type WebviewEnvelope = {
	type?: string
	grpc_request?: GrpcRequest
	grpc_request_cancel?: { request_id?: string }
}

export type GrpcRequest = {
	service?: string
	method?: string
	request_id?: string
	requestId?: string
	is_streaming?: boolean
	isStreaming?: boolean
	message?: unknown
}

type TrackedChangeSummary = {
	filePath: string
	beforePath: string
	afterPath: string
	action: string
	additions: number
	deletions: number
}

type ToolActivityEntry = {
	kind: "file" | "search" | "edit" | "command" | "tool"
	label: string
	detail?: string
}

type ProgressPhase = "activity" | "terminal" | "reasoning"

type NormalizedUsage = {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	totalCost?: number
	reliable: boolean
}

type SendLatencyTrace = {
	requestId: string
	kind: "newTask" | "askResponse"
	sessionId: string
	startedAt: number
	sdkSendAt?: number
	firstSdkEventAt?: number
	firstAssistantAt?: number
	errorAt?: number
	textLength: number
}

type HookLifecycleName = "TaskStart" | "TaskResume" | "TaskCancel" | "TaskComplete" | "PreToolUse" | "PostToolUse" | "UserPromptSubmit"

type HookScript = {
	name: HookLifecycleName
	source: "global" | "workspace"
	path: string
	enabled: boolean
}

type HookExecutionResult = {
	hook: HookScript
	exitCode: number
	stdout: string
	stderr: string
	error?: string
	jsonResponse?: Record<string, unknown>
}

type PreToolUseDecision = {
	blocked: boolean
	reason: string
	inputPatch?: Record<string, unknown>
	replaceInput?: boolean
	validationMessage?: string
	contextPatch?: Record<string, unknown>
	structuredDecision?: Record<string, unknown>
}

type OAuthCallbackSession = {
	provider: string
	state: string
	callbackUrl: string
	authorizationUrl?: string
	createdAt: number
	status: "pending" | "received" | "configured" | "error"
	code?: string
	token?: string
	refreshToken?: string
	tokenType?: string
	expiresAt?: number
	error?: string
	message?: string
	rawQuery?: Record<string, string>
	tokenExchangeSupported?: boolean
	tokenExchange?: OAuthTokenExchangeConfig
	tokenResponse?: Record<string, unknown>
}

type OAuthTokenExchangeConfig = {
	tokenUrl: string
	clientId: string
	clientSecret?: string
	scope?: string
	codeVerifier?: string
	authMethod?: string
}

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

export class VisualStudioWebviewRouter {
	private clineSdk: ClineSdkRuntime | null = null
	private readonly stateStreamRequestIds = new Set<string>()
	private readonly partialMessageStreamRequestIds = new Set<string>()
	private readonly mcpServerStreamRequestIds = new Set<string>()
	private readonly taskSnapshots = new Map<string, { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> }>()
	private readonly lastStateBroadcastKeys = new Map<string, string>()
	private readonly state: ReturnType<typeof createInitialState>
	private pendingApproval:
		| {
				resolve: (value: ToolApprovalResult) => void
		  }
		| null = null
	private pendingQuestion:
		| {
				resolve: (value: AskQuestionResult) => void
		  }
		| null = null
	private messageSequence = 0
	private activePartialTextTs: number | null = null
	private activeAssistantTextBuffer = ""
	private activeReasoningTextTs: number | null = null
	private activeFoldedReasoningText = ""
	private activeFoldedActivityText = ""
	private activeTerminalActivityText = ""
	private activeProgressPhase: ProgressPhase | null = null
	private activeToolActivityTs: number | null = null
	private activeToolActivityEntries: ToolActivityEntry[] = []
	private terminalStateTimer: NodeJS.Timeout | null = null
	private terminalStatePolling = false
	private lastTerminalOutputSequence = 0
	private partialIdleTimer: NodeJS.Timeout | null = null
	private partialStateBroadcastTimer: NodeJS.Timeout | null = null
	private persistedStateSaveTimer: NodeJS.Timeout | null = null
	private readonly lastPartialMessageKeys = new Map<string, string>()
	private lastPartialStateBroadcastAt = 0
	private stateHydrationRefreshInFlight = false
	private taskIdleNoticeTimer: NodeJS.Timeout | null = null
	private taskIdleTimer: NodeJS.Timeout | null = null
	private lastTaskActivityAt = 0
	private lastTaskActivityReason = ""
	private reasoningStartedAt = 0
	private reasoningChunkCount = 0
	private lastReasoningStatusAt = 0
	private lastToolSummaries: string[] = []
	private readonly recentlyTrackedChangePaths = new Map<string, number>()
	private readonly pendingChangeSummaries = new Map<string, TrackedChangeSummary>()
	private changeSummaryTimer: NodeJS.Timeout | null = null
	private readonly closingSessionIds = new Set<string>()
	private readonly deletedTaskIds = new Set<string>()
	private readonly sendLatencyTraces = new Map<string, SendLatencyTrace>()
	private sdkRunGeneration = 0
	private runtimeSettingsRevision = 0
	private activeSessionRuntimeSettingsRevision = 0
	private oauthCallbackServer: http.Server | null = null
	private oauthCallbackPort = 0
	private readonly oauthCallbackSessions = new Map<string, OAuthCallbackSession>()
	private readonly browserSessions = new Map<string, BrowserSessionRecord>()

	private readonly inertStreams = new Set([
		"UiService.subscribeToMcpButtonClicked",
		"UiService.subscribeToHistoryButtonClicked",
		"UiService.subscribeToChatButtonClicked",
		"UiService.subscribeToSettingsButtonClicked",
		"UiService.subscribeToWorktreesButtonClicked",
		"UiService.subscribeToAccountButtonClicked",
		"UiService.subscribeToRelinquishControl",
		"UiService.subscribeToShowWebview",
		"UiService.subscribeToAddToInput",
		"McpService.subscribeToMcpMarketplaceCatalog",
		"ModelsService.subscribeToOpenRouterModels",
		"ModelsService.subscribeToLiteLlmModels",
	])

	constructor(private readonly connection: JsonRpcConnection) {
		this.state = loadInitialState()
		for (const [taskId, snapshot] of Object.entries(this.state.taskSnapshots)) {
			const normalized = cloneTaskSnapshot(snapshot)
			if (normalized) {
				this.taskSnapshots.set(taskId, normalized)
			}
		}
	}

	setClineSdk(clineSdk: ClineSdkRuntime) {
		this.clineSdk = clineSdk
	}

	dispose() {
		this.flushPersistedStateSave()
	}

	isScheduledAgentsEnabled() {
		return this.state.scheduledAgentsEnabled === true || process.env.VSCLINE_ENABLE_AUTOMATION === "1"
	}

	private isPlanModeToolBlocked(mappedToolName: string) {
		if (this.state.mode !== "plan") {
			return false
		}
		return isPlanModeBlockedTool(mappedToolName)
	}

	async requestToolApproval(request: unknown): Promise<ToolApprovalResult> {
		logInteraction("sdk->sidecar", "toolApproval.request", request)
		const approvalRequest = asRecord(request)
		const toolName = getString(approvalRequest, "toolName") || getString(approvalRequest, "name") || getString(approvalRequest, "tool")
		const input = asRecord(approvalRequest.input || approvalRequest.params || approvalRequest.arguments)
		const mappedToolName = mapToolName(toolName)
		if (this.isPlanModeToolBlocked(mappedToolName)) {
			const language = this.getUiLanguage()
			const reason =
				language === "ko"
					? "Plan 모드에서는 실행/수정/브라우저/MCP 도구를 실행하지 않습니다. Act 모드로 전환한 뒤 다시 시도해 주세요."
					: "Plan mode does not run execution, edit, browser, or MCP tools. Switch to Act mode and try again."
			this.addMessage({
				type: "say",
				say: "info",
				text: reason,
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			return { approved: false, reason }
		}
		const hookDecision = await this.runPreToolUseHooks({
			sessionId: this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""),
			toolName,
			mappedToolName,
			input,
			approvalRequest,
		})
		if (hookDecision.blocked) {
			return { approved: false, reason: hookDecision.reason || "Blocked by PreToolUse hook." }
		}
		if (hookDecision.inputPatch && Object.keys(hookDecision.inputPatch).length > 0) {
			applyPreToolUseInputPatch(input, approvalRequest, hookDecision)
			logInteraction("sidecar", "preToolUseInputPatched", {
				toolName,
				mappedToolName,
				replaceInput: hookDecision.replaceInput === true,
				keys: Object.keys(hookDecision.inputPatch),
				reason: hookDecision.reason || undefined,
			})
		}
		if (shouldAutoApproveTool(toolName, this.state.autoApprovalSettings)) {
			await this.notifyAutoApprovedTool(mappedToolName, input)
			return { approved: true, reason: "Auto-approved by Visual Studio settings." }
		}
		const ask = mappedToolName === "executeCommand" ? "command" : "tool"
		const text =
			ask === "command"
				? JSON.stringify({
						command: getCommandText(input),
						description: getString(approvalRequest, "description") || getString(approvalRequest, "reason") || "LIG VS가 이 명령을 실행하려고 합니다.",
					})
				: JSON.stringify({
						tool: mappedToolName,
						path:
							mappedToolName === "searchFiles"
								? getToolPath(input) || "/"
								: getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input),
						regex: mappedToolName === "searchFiles" ? getSearchQuery(input) : undefined,
						filePattern: mappedToolName === "searchFiles" ? getSearchFilePattern(input) : undefined,
						content: getString(approvalRequest, "description") || getString(approvalRequest, "reason") || summarizeToolInput(input),
						...input,
					})

		if (this.pendingApproval) {
			this.pendingApproval.resolve({ approved: false, reason: "Superseded by a newer LIG VS tool approval request." })
			this.pendingApproval = null
		}

		this.addMessage({ type: "ask", ask, text })
		this.updateCurrentTaskItem()
		await this.broadcastState()

		return new Promise<ToolApprovalResult>((resolve) => {
			this.pendingApproval = { resolve }
		})
	}

	private async notifyAutoApprovedTool(mappedToolName: string, input: Record<string, unknown>) {
		const settings = asRecord(this.state.autoApprovalSettings)
		if (settings.enableNotifications !== true) {
			return
		}

		const detail =
			mappedToolName === "executeCommand"
				? getCommandText(input)
				: getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input) || getSearchQuery(input)
		const suffix = detail ? `: ${truncateForStatus(detail, 120)}` : ""
		try {
			await VisualStudioHostProvider.create(this.connection).windowClient.showMessage({
				message: `LIG VS auto-approved ${mappedToolName}${suffix}`,
				type: "info",
			})
		} catch (error) {
			logInteraction("sidecar", "autoApproveNotificationFailed", { error: stringify(error) })
		}
	}

	async requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> {
		logInteraction("sdk->sidecar", "question.request", { question, options })
		if (this.pendingQuestion) {
			this.pendingQuestion.resolve("")
			this.pendingQuestion = null
		}
		this.removeAskMessages("followup")

		this.addMessage({
			type: "ask",
			ask: "followup",
			text: JSON.stringify({
				question,
				options,
			}),
		})
		this.updateCurrentTaskItem()
		await this.broadcastState()

		return new Promise<AskQuestionResult>((resolve) => {
			this.pendingQuestion = { resolve }
		})
	}

	handleSdkEvent(event: unknown) {
		if (shouldLogSdkEventForInteraction(event)) {
			logInteraction("sdk->sidecar", "sdk.event", summarizeSdkEventForLog(event))
		}
		const record = asRecord(event)
		const type = getString(record, "type")
		const payload = asRecord(record.payload)

		if (type === "agent_event") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				logInteraction("sidecar", "ignoredSdkAgentEvent", {
					sessionId,
					activeSessionId: this.clineSdk?.status.activeSessionId,
					currentTaskId: this.state.currentTaskItem?.id,
				})
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, getString(asRecord(payload.event), "type") || type)
			this.handleAgentEvent(asRecord(payload.event), sessionId)
			return
		}

		if (type === "vscline_file_changed") {
			this.handleFileChangedEvent(payload).catch((error) => console.error(error))
			return
		}

		if (type === "chunk") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, type)
			this.handleSessionChunk(payload)
			return
		}

		if (type === "session_snapshot") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, type)
			this.handleSessionSnapshot(payload)
			return
		}

		if (type === "team_progress") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handleTeamProgress(payload)
			return
		}

		if (type === "hook") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handleHookEvent(payload)
			return
		}

		if (type === "pending_prompts") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handlePendingPrompts(payload)
			return
		}

		if (type === "pending_prompt_submitted") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handlePendingPromptSubmitted(payload)
			return
		}

		if (type === "status") {
			const status = getString(payload, "status")
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, `status:${status}`)
			if (status === "idle") {
				logInteraction("sidecar", "sdkStatusIdle", { sessionId })
				this.finishSdkTask(sessionId, "completed", this.getActivePartialText())
				this.updateCurrentTaskItem()
				this.broadcastState().catch((error) => console.error(error))
				return
			}
			if (isTerminalSdkStatus(status)) {
				const activeText = this.getActivePartialText()
				this.finishSdkTask(sessionId, status, activeText)
				this.updateCurrentTaskItem()
				this.broadcastState().catch((error) => console.error(error))
				return
			}
			this.noteTaskActivity(status || type)
			this.schedulePartialStateBroadcast()
			return
		}

		if (type === "ended") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			const activeText = this.getActivePartialText()
			this.finishSdkTask(sessionId, getString(payload, "reason") || "ended", activeText)
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
		}
	}

	async handle(params: unknown) {
		let envelope: WebviewEnvelope | null = null

		try {
			const rawJson = typeof params === "object" && params !== null && "rawJson" in params ? (params as any).rawJson : "{}"
			envelope = JSON.parse(String(rawJson)) as WebviewEnvelope
			logInteraction("webview->sidecar", envelope?.type || "webview.message", envelope)
		} catch {
			return {
				handled: false,
				reason: "invalid_webview_json",
			}
		}

		if (envelope?.type === "grpc_request" && envelope.grpc_request) {
			const handledGrpc = await this.handleGrpcRequest(envelope.grpc_request)
			if (handledGrpc) {
				return handledGrpc
			}
		}

		if (envelope?.type === "grpc_request_cancel") {
			const requestId = readRequestId(envelope.grpc_request_cancel)
			if (!requestId) {
				return {
					handled: false,
					reason: "missing_cancel_request_id",
					webviewMessages: [],
				}
			}
			if (this.stateStreamRequestIds.delete(requestId) || this.partialMessageStreamRequestIds.delete(requestId)) {
				this.lastStateBroadcastKeys.delete(requestId)
				this.lastPartialMessageKeys.delete(requestId)
				logInteraction("webview->sidecar", "grpc_request_cancel.streamDisposed", { requestId })
				return {
					handled: true,
					owner: "sidecar",
					webviewMessages: [],
				}
			}
			if (this.mcpServerStreamRequestIds.delete(requestId)) {
				logInteraction("webview->sidecar", "grpc_request_cancel.mcpStreamDisposed", { requestId })
				return {
					handled: true,
					owner: "sidecar",
					webviewMessages: [],
				}
			}
			logInteraction("webview->sidecar", "grpc_request_cancel.ignored", { requestId })
			return {
				handled: true,
				owner: "sidecar",
				webviewMessages: [],
			}
		}

		return {
			handled: false,
			type: envelope?.type || "",
			webviewMessages: [],
		}
	}

	private async handleGrpcRequest(request: GrpcRequest) {
		logInteraction("webview->sidecar", `${request.service || ""}.${request.method || ""}`, request)
		const startedAt = Date.now()
		const service = request.service || ""
		const method = request.method || ""
		const requestId = readRequestId(request)
		const isStreaming = request.is_streaming === true || request.isStreaming === true
		const key = `${service}.${method}`

		if (!requestId) {
			return null
		}

		if (isStreaming) {
			const result = await this.handleStreamingRequest(key, requestId)
			this.logSlowGrpcRequest(key, startedAt, true)
			return result
		}

		try {
			const result = await this.handleUnaryRequest(key, requestId, request.message)
			this.logSlowGrpcRequest(key, startedAt, false)
			return result
		} catch (error) {
			this.logSlowGrpcRequest(key, startedAt, false)
			const message = error instanceof Error ? error.message : String(error)
			this.addMessage({ type: "say", say: "error", text: message })
			this.updateCurrentTaskItem()
			await this.broadcastState()
			return grpcHandled(grpcError(requestId, message, false))
		}
	}

	private async handleStreamingRequest(key: string, requestId: string) {
		if (key === "StateService.subscribeToState") {
			this.stateStreamRequestIds.add(requestId)
			this.scheduleStateStreamsRefresh()
			return grpcHandled(grpcResponse(requestId, { stateJson: JSON.stringify(this.state) }, true))
		}

		if (key === "AccountService.subscribeToAuthStatusUpdate") {
			return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), true))
		}

		if (key === "UiService.subscribeToPartialMessage") {
			this.partialMessageStreamRequestIds.add(requestId)
			return grpcHandled()
		}

		if (key === "McpService.subscribeToMcpServers") {
			this.mcpServerStreamRequestIds.add(requestId)
			return grpcHandled(grpcResponse(requestId, await this.getMcpServersResponse(), true))
		}

		if (key === "McpService.subscribeToMcpMarketplaceCatalog") {
			return grpcHandled(grpcResponse(requestId, this.getMcpMarketplaceResponse(), true))
		}

		if (key === "OcaAccountService.ocaSubscribeToAuthStatusUpdate") {
			return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), true))
		}

		if (this.inertStreams.has(key)) {
			return {
				handled: true,
				owner: "sidecar",
				reason: "registered_inert_stream",
				webviewMessages: [],
			}
		}

		return null
	}

	private async handleUnaryRequest(key: string, requestId: string, message: unknown) {
		const host = VisualStudioHostProvider.create(this.connection)

		switch (key) {
			case "UiService.initializeWebview":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "UiService.onDidShowAnnouncement":
				return grpcHandled(grpcResponse(requestId, { value: false }, false))

			case "UiService.openUrl":
				await host.envClient.openExternal({ value: getExternalUrlValue(message) })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "UiService.openWalkthrough":
			case "UiService.setTerminalExecutionMode":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "WebService.openInBrowser":
				await host.envClient.openExternal({ value: getExternalUrlValue(message) })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "WebService.checkIsImageUrl":
				return grpcHandled(grpcResponse(requestId, await checkIsImageUrl(getString(message, "value") || getString(message, "url")), false))

			case "WebService.fetchOpenGraphData":
				return grpcHandled(grpcResponse(requestId, await fetchOpenGraphData(getString(message, "value") || getString(message, "url")), false))

			case "AccountService.getRedirectUrl":
				return grpcHandled(grpcResponse(requestId, await this.createOAuthCallbackBridgeResponse(message, "account"), false))

			case "AccountService.getUserOrganizations":
				return grpcHandled(grpcResponse(requestId, { organizations: [] }, false))

			case "AccountService.getUserCredits":
			case "AccountService.getOrganizationCredits":
				return grpcHandled(grpcResponse(requestId, { credits: 0, balance: 0, value: 0 }, false))

			case "AccountService.setUserOrganization":
			case "AccountService.submitLimitIncreaseRequest":
				return grpcHandled(grpcResponse(requestId, createVisualStudioAuthUnsupportedResponse("account"), false))

			case "AccountService.accountLoginClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("account"), false))

			case "AccountService.accountLogoutClicked":
				this.state.openAiCodexIsAuthenticated = false
				this.clearOAuthCredential("account")
				this.clearOAuthCredential("openai-codex")
				savePersistedState(this.state)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), false))

			case "AccountService.openrouterAuthClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("openrouter", message), false))

			case "AccountService.requestyAuthClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("requesty", message), false))

			case "AccountService.hicapAuthClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("hicap", message), false))

			case "AccountService.openAiCodexSignIn":
				this.state.openAiCodexIsAuthenticated = false
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("openAiCodex", message), false))

			case "AccountService.openAiCodexSignOut":
				this.state.openAiCodexIsAuthenticated = false
				this.clearOAuthCredential("openai-codex")
				savePersistedState(this.state)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), false), ...this.buildStateMessages())

			case "AccountService.saveProviderCredential":
			case "AccountService.storeProviderCredential":
			case "AccountService.saveProviderToken":
				return grpcHandled(grpcResponse(requestId, await this.saveProviderCredential(message), false), ...this.buildStateMessages())

			case "AccountService.getProviderCredentialStatus":
			case "AccountService.getProviderAuthStatus":
				return grpcHandled(grpcResponse(requestId, this.getProviderCredentialStatus(message), false))

			case "AccountService.refreshProviderCredential":
			case "AccountService.refreshProviderToken":
			case "AccountService.refreshOAuthCredential":
				return grpcHandled(grpcResponse(requestId, await this.refreshOAuthCredential(message), false), ...this.buildStateMessages())

			case "AccountService.getProviderConfigFields":
			case "AccountService.getProviderAuthRequirements":
				return grpcHandled(grpcResponse(requestId, await this.getProviderConfigFields(message), false))

			case "AccountService.getOAuthCallbackStatus":
			case "AccountService.getProviderOAuthCallbackStatus":
				return grpcHandled(grpcResponse(requestId, this.getOAuthCallbackStatus(message), false))

			case "AccountService.submitOAuthCallback":
			case "AccountService.completeOAuthCallback":
			case "AccountService.saveOAuthCallback":
				return grpcHandled(grpcResponse(requestId, await this.submitOAuthCallback(message), false), ...this.buildStateMessages())

			case "AccountService.clearProviderCredential":
			case "AccountService.deleteProviderCredential":
			case "AccountService.clearProviderToken":
				return grpcHandled(grpcResponse(requestId, await this.clearProviderCredential(message), false), ...this.buildStateMessages())

			case "OcaAccountService.ocaAccountLoginClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("oca", message), false))

			case "OcaAccountService.ocaAccountLogoutClicked":
				return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), false))

			case "BrowserService.getDetectedChromePath": {
				const detectedPath = resolveBrowserExecutablePath(getString(asRecord(this.state.browserSettings), "chromeExecutablePath"))
				return grpcHandled(grpcResponse(requestId, { path: detectedPath, isBundled: false }, false))
			}

			case "BrowserService.getBrowserConnectionInfo":
				return grpcHandled(grpcResponse(requestId, await this.getBrowserConnectionInfo(), false))

			case "BrowserService.testBrowserConnection": {
				const hostValue = getString(message, "value") || getString(message, "host") || getString(message, "url")
				const debugInfo = await fetchBrowserDebugInfo(hostValue)
				const success = Boolean(debugInfo.success)
				return grpcHandled(
					grpcResponse(
						requestId,
						{
							success,
							message: success
								? `Browser connection successful.${debugInfo.browser ? ` ${debugInfo.browser}` : ""}`
								: debugInfo.error || "Unable to reach the configured browser host.",
							host: debugInfo.host || normalizeBrowserDebugHost(hostValue),
							browser: debugInfo.browser || "",
							protocolVersion: debugInfo.protocolVersion || "",
							tabCount: debugInfo.tabCount ?? 0,
							activeTabTitle: debugInfo.activeTabTitle || "",
							activeTabUrl: debugInfo.activeTabUrl || "",
							webFetchEnabled: isWebFetchEnabled(this.state.browserSettings),
							webFetchDisabledReason: webFetchDisabledReason(this.state.browserSettings),
							browserToolUseDisabled: asRecord(this.state.browserSettings).disableToolUse === true,
						},
						false,
					),
				)
			}

			case "BrowserService.discoverBrowser":
				return grpcHandled(grpcResponse(requestId, await this.discoverBrowser(), false))

			case "BrowserService.relaunchChromeDebugMode": {
				const browserSettings = asRecord(this.state.browserSettings)
				const host = getString(browserSettings, "remoteBrowserHost") || "http://localhost:9222"
				return grpcHandled(
					grpcResponse(
						requestId,
						{
							success: false,
							value:
								"Automatic Chrome relaunch is not implemented in the Visual Studio host yet. " +
								`Launch Chrome or Edge manually with remote debugging enabled, for example: chrome.exe --remote-debugging-port=9222, then reconnect to ${host}.`,
							message:
								"Automatic Chrome relaunch is not implemented in the Visual Studio host yet. " +
								`Launch Chrome or Edge manually with remote debugging enabled, then reconnect to ${host}.`,
						},
						false,
					),
				)
			}

			case "BrowserService.listBrowserTabs":
				return grpcHandled(grpcResponse(requestId, await this.listBrowserTabs(), false))

			case "BrowserService.captureScreenshot":
				return grpcHandled(grpcResponse(requestId, await this.captureBrowserScreenshot(message), false))

			case "BrowserService.performBrowserAction":
			case "BrowserService.executeBrowserAction":
				return grpcHandled(grpcResponse(requestId, await this.performBrowserAction(message), false))

			case "StateService.getAvailableTerminalProfiles":
				return grpcHandled(
					grpcResponse(
						requestId,
						{
							profiles: [
								{
									id: "visual-studio-command-host",
									name: "Visual Studio Command Host",
								},
							],
						},
						false,
					),
				)

			case "TerminalService.openTerminalPanel":
			case "UiService.openTerminalPanel":
				return grpcHandled(grpcResponse(requestId, await host.workspaceClient.openTerminalPanel(asRecord(message)), false))

			case "TerminalService.attachTerminalCommand":
			case "UiService.attachTerminalCommand":
				return grpcHandled(
					grpcResponse(requestId, await host.workspaceClient.attachTerminalCommand(asRecord(message)), false),
					...this.buildStateMessages(),
				)

			case "TerminalService.continueTerminalCommand":
			case "UiService.continueTerminalCommand":
				return grpcHandled(
					grpcResponse(requestId, await host.workspaceClient.continueTerminalCommand(asRecord(message)), false),
					...this.buildStateMessages(),
				)

			case "StateService.updateSettings":
			case "StateService.updateAutoApprovalSettings":
			case "ModelsService.updateApiConfigurationProto":
			case "ModelsService.updateApiConfiguration":
				this.applySettings(message)
				savePersistedState(this.state)
				return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())

			case "StateService.togglePlanActModeProto":
				this.state.mode = resolveRequestedPlanActMode(message, this.state.mode)
				savePersistedState(this.state)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, { value: true, mode: this.state.mode }, false))

			case "StateService.updateTelemetrySetting":
				this.state.telemetrySetting = getString(message, "value") || getString(message, "telemetrySetting") || this.state.telemetrySetting
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.dismissBanner":
				this.applyBannerDismissal(message)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateInfoBannerVersion":
				this.state.lastDismissedInfoBannerVersion = getNumber(message, "value") || getNumber(message, "version") || this.state.lastDismissedInfoBannerVersion
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateModelBannerVersion":
				this.state.lastDismissedModelBannerVersion = getNumber(message, "value") || getNumber(message, "version") || this.state.lastDismissedModelBannerVersion
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateCliBannerVersion":
				this.state.lastDismissedCliBannerVersion = getNumber(message, "value") || getNumber(message, "version") || this.state.lastDismissedCliBannerVersion
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateTerminalConnectionTimeout":
				this.state.shellIntegrationTimeout = getNumber(message, "value") || getNumber(message, "timeout") || this.state.shellIntegrationTimeout
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.setWelcomeViewCompleted":
				this.state.welcomeViewCompleted = true
				this.state.isNewUser = false
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.captureOnboardingProgress":
			case "StateService.refreshRemoteConfig":
			case "StateService.testOtelConnection":
			case "StateService.testPromptUploading":
			case "StateService.installClineCli":
				return grpcHandled(grpcResponse(requestId, { value: false }, false))

			case "StateService.toggleFavoriteModel":
				this.toggleFavoriteModel(getString(message, "value") || getString(message, "modelId"))
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.resetState":
				clearPersistedState()
				Object.assign(this.state, createInitialState())
				await this.clearTask()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.clearTask":
				await this.clearTask()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.newTask":
				if (this.pendingQuestion) {
					await this.sendAskResponse(message, requestId)
					return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())
				}
				if (this.state.currentTaskItem && getString(message, "text").trim()) {
					await this.sendAskResponse(message, requestId)
					return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())
				}
				await this.startNewTask(message, { broadcast: true, requestId })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.askResponse":
				await this.sendAskResponse(message, requestId)
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "SlashService.condense":
				await this.compactCurrentSession(requestId)
				return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())

			case "TaskService.cancelTask":
				await this.cancelTask()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.getTaskHistory":
				this.refreshTaskHistoryFromSdkInBackground("getTaskHistory")
				return grpcHandled(grpcResponse(requestId, { tasks: this.state.taskHistory }, false))

			case "TaskService.getTotalTasksSize":
				this.refreshTaskHistoryFromSdkInBackground("getTotalTasksSize")
				return grpcHandled(grpcResponse(requestId, { value: this.state.taskHistory.length }, false))

			case "TaskService.showTaskWithId":
				await this.showTaskWithId(getString(message, "value") || getString(message, "taskId"))
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.deleteTasksWithIds":
				await this.deleteTasks(getStringArray(message, "value"))
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.deleteAllTaskHistory":
				await this.deleteAllTasks()
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "CheckpointsService.checkpointRestore":
				await this.restoreCheckpoint(message)
				return grpcHandled(grpcResponse(requestId, { value: true }, false))

			case "CheckpointsService.checkpointDiff":
				return grpcHandled(grpcResponse(requestId, await this.describeCheckpointDiff(message), false), ...this.buildStateMessages())

			case "FileService.refreshRules":
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.refreshSkills":
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkSkills(), false))

			case "FileService.toggleClineRule":
				await this.toggleSdkSetting("rules", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.toggleCursorRule":
			case "FileService.toggleWindsurfRule":
			case "FileService.toggleAgentsRule":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.toggleWorkflow":
				await this.toggleSdkSetting("workflows", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.toggleSkill":
				await this.toggleSdkSetting("skills", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkSkills(), false))

			case "FileService.refreshHooks":
				return grpcHandled(grpcResponse(requestId, await this.refreshHookSettings(), false))

			case "FileService.createHook":
				return grpcHandled(grpcResponse(requestId, await this.createHook(message), false))

			case "FileService.deleteHook":
				return grpcHandled(grpcResponse(requestId, await this.deleteHook(message), false))

			case "FileService.toggleHook":
				return grpcHandled(grpcResponse(requestId, await this.toggleHook(message), false))

			case "ScheduledAgentsService.listSpecs":
			case "ScheduledAgentsService.listScheduledAgents":
			case "AutomationService.listScheduledAgents":
				return grpcHandled(grpcResponse(requestId, await this.listScheduledAgentSpecs(), false))

			case "ScheduledAgentsService.createSpec":
			case "ScheduledAgentsService.updateSpec":
			case "ScheduledAgentsService.saveSpec":
			case "AutomationService.saveScheduledAgent":
				return grpcHandled(grpcResponse(requestId, await this.saveScheduledAgentSpec(message), false))

			case "ScheduledAgentsService.deleteSpec":
			case "ScheduledAgentsService.deleteScheduledAgent":
			case "AutomationService.deleteScheduledAgent":
				return grpcHandled(grpcResponse(requestId, await this.deleteScheduledAgentSpec(message), false))

			case "ScheduledAgentsService.runSpec":
			case "ScheduledAgentsService.runScheduledAgent":
			case "AutomationService.runScheduledAgent":
				return grpcHandled(grpcResponse(requestId, await this.runScheduledAgentSpec(message), false), ...this.buildStateMessages())

			case "PluginService.listPlugins":
			case "PluginService.getPluginConfigStatus":
			case "PluginsService.listPlugins":
			case "PluginsService.getPluginConfigStatus":
				return grpcHandled(grpcResponse(requestId, await this.getLocalPluginConfigStatus(), false))

			case "FileService.createRuleFile":
			case "FileService.deleteRuleFile":
			case "FileService.createSkillFile":
			case "FileService.deleteSkillFile":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.openVsClineDiff": {
				const leftPath = getString(message, "leftPath") || getString(message, "beforePath")
				const rightPath = getString(message, "rightPath") || getString(message, "afterPath") || getString(message, "filePath")
				const title = getString(message, "title") || (rightPath ? `LIG VS change: ${path.basename(rightPath)}` : "LIG VS change")
				if (leftPath && rightPath) {
					await VisualStudioHostProvider.create(this.connection).diffClient.openDiff({ leftPath, rightPath, title })
				} else if (rightPath) {
					await VisualStudioHostProvider.create(this.connection).windowClient.openFile({ filePath: rightPath })
				}
				return grpcHandled(grpcResponse(requestId, {}, false))
			}

			case "FileService.revertVsClineChanges":
				return grpcHandled(grpcResponse(requestId, await this.revertVsClineChanges(message), false), ...this.buildStateMessages())

			case "FileService.copyToClipboard":
				await VisualStudioHostProvider.create(this.connection).envClient.clipboardWriteText({
					value: getString(message, "value") || getString(message, "text"),
				})
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.ifFileExistsRelativePath": {
				const relativePath = getString(message, "value") || getString(message, "path") || getString(message, "relativePath")
				const workspaceRoot = await this.getPrimaryWorkspaceRoot()
				const fullPath = workspaceRoot && relativePath ? path.resolve(workspaceRoot, relativePath) : ""
				const exists = fullPath ? fs.existsSync(fullPath) : false
				return grpcHandled(grpcResponse(requestId, { value: exists }, false))
			}

			case "FileService.getRelativePaths":
				return grpcHandled(grpcResponse(requestId, { values: [], paths: [] }, false))

			case "FileService.searchFiles":
			case "FileService.searchCommits":
				return grpcHandled(grpcResponse(requestId, { results: [], values: [] }, false))

			case "FileService.selectFiles": {
				try {
					const selected = await host.workspaceClient.selectFiles({
						allowImages: getBoolean(message, "value") || getBoolean(message, "allowImages"),
					})
					return grpcHandled(
						grpcResponse(
							requestId,
							{
								values1: Array.isArray(selected.values1) ? selected.values1 : selected.images || [],
								values2: Array.isArray(selected.values2) ? selected.values2 : selected.files || [],
							},
							false,
						),
					)
				} catch (error) {
					await host.windowClient.showMessage({
						message: `LIG VS could not open the file picker: ${stringify(error)}`,
						type: "warning",
					})
					return grpcHandled(grpcResponse(requestId, { values1: [], values2: [], error: stringify(error) }, false))
				}
			}

			case "FileService.openMention":
			case "FileService.openDiskConversationHistory":
			case "FileService.openFocusChainFile":
			case "FileService.openImage":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.openFile":
			case "FileService.openFileRelativePath": {
				const filePath =
					getString(message, "filePath") ||
					getString(message, "path") ||
					getString(message, "value") ||
					getString(message, "relativePath")
				const workspaceRoot = await this.getPrimaryWorkspaceRoot()
				const fullPath = path.isAbsolute(filePath) ? filePath : workspaceRoot ? path.resolve(workspaceRoot, filePath) : filePath
				if (fullPath) {
					await host.windowClient.openFile({ filePath: fullPath, line: getNumber(message, "line") })
				}
				return grpcHandled(grpcResponse(requestId, {}, false))
			}

			case "ModelsService.getOllamaModels": {
				const values = await getOllamaModels(getString(message, "value"))
				if (values.length > 0) {
					this.applyDefaultOllamaModel(values[0])
				}
				return grpcHandled(grpcResponse(requestId, { values }, false))
			}

			case "ModelsService.getLmStudioModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("lmstudio", asRecord(message)), false))

			case "ModelsService.refreshOpenAiModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("openai-compatible", asRecord(message)), false))

			case "ModelsService.refreshLiteLlmModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("litellm", asRecord(message)), false))

			case "ModelsService.refreshOpenRouterModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("openrouter", asRecord(message)), false))

			case "ModelsService.refreshRequestyModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("requesty", asRecord(message)), false))

			case "ModelsService.refreshGroqModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("groq", asRecord(message)), false))

			case "ModelsService.refreshVercelAiGatewayModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("vercel-ai-gateway", asRecord(message)), false))

			case "ModelsService.refreshHicapModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("hicap", asRecord(message)), false))

			case "ModelsService.getAihubmixModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("aihubmix", asRecord(message)), false))

			case "ModelsService.refreshOcaModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("oca", asRecord(message)), false))

			case "ModelsService.refreshBasetenModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("baseten", asRecord(message)), false))

			case "ModelsService.refreshHuggingFaceModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("huggingface", asRecord(message)), false))

			case "ModelsService.getSapAiCoreModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("sapaicore", asRecord(message)), false))

			case "ModelsService.getVsCodeLmModels":
			case "ModelsService.refreshClineModelsRpc":
			case "ModelsService.refreshClineRecommendedModelsRpc":
				return grpcHandled(grpcResponse(requestId, this.createUnsupportedModelCatalog(key), false))

			case "WorktreeService.listWorktrees":
				return grpcHandled(grpcResponse(requestId, await this.listWorktrees(), false))

			case "WorktreeService.getWorktreeDefaults":
				return grpcHandled(grpcResponse(requestId, await this.getWorktreeDefaults(), false))

			case "WorktreeService.getWorktreeIncludeStatus":
				return grpcHandled(grpcResponse(requestId, await this.getWorktreeIncludeStatus(), false))

			case "WorktreeService.createWorktreeInclude":
				return grpcHandled(grpcResponse(requestId, await this.createWorktreeInclude(message), false))

			case "WorktreeService.createWorktree":
				return grpcHandled(grpcResponse(requestId, await this.createWorktree(message), false))

			case "WorktreeService.switchWorktree":
				return grpcHandled(grpcResponse(requestId, await this.switchWorktree(message), false))

			case "WorktreeService.mergeWorktree":
				return grpcHandled(grpcResponse(requestId, await this.mergeWorktree(message), false))

			case "WorktreeService.recoverMerge":
			case "WorktreeService.mergeRecovery":
				return grpcHandled(grpcResponse(requestId, await this.recoverWorktreeMerge(message), false))

			case "WorktreeService.deleteWorktree":
				return grpcHandled(grpcResponse(requestId, await this.deleteWorktree(message), false))

			case "WorktreeService.trackWorktreeViewOpened":
				return grpcHandled(grpcResponse(requestId, { success: true }, false))

			case "McpService.getLatestMcpServers":
				return grpcHandled(grpcResponse(requestId, await this.getMcpServersResponse(), false))

			case "McpService.refreshMcpMarketplace":
				return grpcHandled(grpcResponse(requestId, this.getMcpMarketplaceResponse(), false))

			case "McpService.addRemoteMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireClineSdk().addRemoteMcpServer(message))

			case "McpService.openMcpSettings":
				await this.openMcpSettingsFile()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "McpService.updateMcpTimeout":
				return this.grpcMcpServersMutation(requestId, await this.requireClineSdk().updateMcpTimeout(message))

			case "McpService.restartMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireClineSdk().restartMcpServer(message))

			case "McpService.deleteMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireClineSdk().deleteMcpServer(message))

			case "McpService.toggleToolAutoApprove":
				return this.grpcMcpServersMutation(requestId, await this.requireClineSdk().toggleMcpToolAutoApprove(message))

			case "McpService.toggleMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireClineSdk().setMcpServerDisabled(message))

			case "McpService.authenticateMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireClineSdk().authenticateMcpServer(message))

			case "McpService.downloadMcp":
				return grpcHandled(
					grpcError(
						requestId,
						"MCP marketplace installation is not implemented in the Visual Studio port yet. Add stdio/SSE/streamable HTTP servers from the MCP configuration file or Add Server tab.",
						false,
					),
				)

			case "TaskService.toggleTaskFavorite":
				this.toggleTaskFavorite(getString(message, "taskId"), asRecord(message).isFavorited === true)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			default:
				return null
		}
	}

	private logSlowGrpcRequest(key: string, startedAt: number, streaming: boolean) {
		const durationMs = Date.now() - startedAt
		const thresholdMs = readPositiveIntEnv("VSCLINE_SLOW_WEBVIEW_RPC_MS", 750)
		if (durationMs >= thresholdMs) {
			logInteraction("sidecar", "webviewRpcSlow", { key, streaming, durationMs, thresholdMs })
		}
	}

	private async handleAccountAuthAction(provider: string, message: unknown = {}) {
		const request = asRecord(message)
		const credential = extractProviderCredentialValue(request)
		if (credential) {
			return this.saveProviderCredential({ ...request, provider, value: credential, source: "auth_action" })
		}

		const bridge = isOAuthBridgeProvider(provider) ? await this.ensureOAuthCallbackBridge(provider, request) : null
		const authInfo = createProviderAuthInfo(provider, message, bridge)
		if (authInfo.url) {
			await VisualStudioHostProvider.create(this.connection).envClient.openExternal({ value: authInfo.url })
		}
		if (authInfo.message) {
			await VisualStudioHostProvider.create(this.connection).windowClient.showMessage({ message: authInfo.message, type: authInfo.supported ? "info" : "warning" })
		}
		if (provider === "openAiCodex") {
			this.state.openAiCodexIsAuthenticated = false
			await this.broadcastState()
		}
		logInteraction("sidecar", "accountAuthAction", {
			provider,
			supported: authInfo.supported,
			url: authInfo.url || undefined,
			reason: getString(authInfo, "reason") || undefined,
		})
		return {
			...createUnauthenticatedAccountState(),
			...authInfo,
		}
	}

	private async createOAuthCallbackBridgeResponse(message: unknown, fallbackProvider: string) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || fallbackProvider)
		const bridge = await this.ensureOAuthCallbackBridge(provider || fallbackProvider, request)
		return {
			success: true,
			supported: true,
			provider: bridge.provider,
			value: bridge.authorizationUrl || bridge.callbackUrl,
			url: bridge.authorizationUrl || undefined,
			authorizationUrl: bridge.authorizationUrl || undefined,
			redirectUrl: bridge.callbackUrl,
			callbackUrl: bridge.callbackUrl,
			state: bridge.state,
			authStatus: "pending",
			tokenExchangeSupported: bridge.tokenExchangeSupported === true,
			message: bridge.authorizationUrl
				? `${providerAuthLabel(bridge.provider)} OAuth authorization URL is ready. Complete sign-in in the browser and return to LIG VS through the localhost callback.`
				: `${providerAuthLabel(bridge.provider)} OAuth callback bridge is ready. Configure a provider authorization URL to open sign-in automatically.`,
		}
	}

	private async ensureOAuthCallbackBridge(provider: string, request: Record<string, unknown> = {}): Promise<OAuthCallbackSession> {
		this.pruneOAuthCallbackSessions()
		if (!this.oauthCallbackServer) {
			await this.startOAuthCallbackServer()
		}

		const normalizedProvider = normalizeProviderValue(provider) || "account"
		const state = randomUUID()
		const callbackUrl = `http://127.0.0.1:${this.oauthCallbackPort}/oauth/callback?provider=${encodeURIComponent(normalizedProvider)}&state=${encodeURIComponent(state)}`
		const authorization = createOAuthAuthorizationRequest(normalizedProvider, callbackUrl, state, request)
		const session: OAuthCallbackSession = {
			provider: normalizedProvider,
			state,
			callbackUrl,
			authorizationUrl: authorization.url || undefined,
			createdAt: Date.now(),
			status: "pending",
			tokenExchangeSupported: authorization.tokenExchangeSupported,
			tokenExchange: authorization.tokenExchange || undefined,
			message: authorization.url ? "Waiting for OAuth provider authorization and redirect." : "Waiting for OAuth provider redirect.",
		}
		this.oauthCallbackSessions.set(state, session)
		logInteraction("sidecar", "oauthCallbackBridgeReady", {
			provider: normalizedProvider,
			state,
			port: this.oauthCallbackPort,
			hasAuthorizationUrl: Boolean(authorization.url),
			tokenExchangeSupported: authorization.tokenExchangeSupported,
		})
		return session
	}

	private async startOAuthCallbackServer() {
		const preferredPort = readOptionalPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_PORT") || 0
		const server = http.createServer((request, response) => {
			this.handleOAuthCallbackHttpRequest(request, response)
		})

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening)
				reject(error)
			}
			const onListening = () => {
				server.off("error", onError)
				resolve()
			}
			server.once("error", onError)
			server.once("listening", onListening)
			server.listen(preferredPort, "127.0.0.1")
		})

		const address = server.address()
		this.oauthCallbackServer = server
		this.oauthCallbackPort = typeof address === "object" && address ? address.port : preferredPort
		logInteraction("sidecar", "oauthCallbackServerListening", { port: this.oauthCallbackPort })
	}

	private handleOAuthCallbackHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
		const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`)
		if (!["/oauth/callback", "/auth/callback", "/callback"].includes(requestUrl.pathname)) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
			response.end("Not found")
			return
		}

		const result = this.recordOAuthCallbackFromUrl(requestUrl)
		response.writeHead(result.success ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
		response.end(
			`<!doctype html><html><body><h3>LIG VS OAuth callback</h3><p>${escapeHtml(result.message)}</p><p>You can close this browser tab.</p></body></html>`,
		)
		if (result.success) {
			const state = requestUrl.searchParams.get("state") || parseUrlFragmentParams(requestUrl).get("state") || ""
			const session = (state && this.oauthCallbackSessions.get(state)) || this.latestOAuthCallbackSession(result.provider || "")
			if (session) {
				this.completeOAuthCallbackSession(session)
					.catch((error) => {
						session.status = "error"
						session.error = stringify(error)
						session.message = `OAuth token exchange failed: ${session.error}`
						logInteraction("sidecar", "oauthTokenExchangeFailed", { provider: session.provider, state: session.state, error: session.error })
					})
					.finally(() => this.broadcastState().catch((error) => console.error(error)))
				return
			}
		}
		this.broadcastState().catch((error) => console.error(error))
	}

	private recordOAuthCallbackFromUrl(url: URL) {
		const hashParams = parseUrlFragmentParams(url)
		const query = {
			...Object.fromEntries(Array.from(url.searchParams.entries()).map(([key, value]) => [key, value])),
			...Object.fromEntries(Array.from(hashParams.entries()).map(([key, value]) => [key, value])),
		}
		const state = url.searchParams.get("state") || hashParams.get("state") || ""
		const provider = normalizeProviderValue(url.searchParams.get("provider") || hashParams.get("provider") || "") || "account"
		const code = url.searchParams.get("code") || hashParams.get("code") || ""
		const token =
			url.searchParams.get("access_token") ||
			hashParams.get("access_token") ||
			url.searchParams.get("token") ||
			hashParams.get("token") ||
			url.searchParams.get("api_key") ||
			hashParams.get("api_key") ||
			url.searchParams.get("key") ||
			hashParams.get("key") ||
			""
		const error = url.searchParams.get("error") || hashParams.get("error") || ""
		const session = (state && this.oauthCallbackSessions.get(state)) || this.latestOAuthCallbackSession(provider)
		if (!session) {
			return { success: false, message: "No matching LIG VS OAuth callback request is pending." }
		}

		session.status = error ? "error" : "received"
		session.code = code || undefined
		session.token = token || undefined
		session.error = error || undefined
		session.rawQuery = query
		session.message = error
			? `OAuth callback failed: ${error}`
			: token
				? "OAuth callback received a token. Credential storage will use the provider API-key field when available."
				: code
					? "OAuth callback received an authorization code. Provider-specific token exchange is still required."
					: "OAuth callback was received, but it did not include a code or token."
		logInteraction("sidecar", "oauthCallbackReceived", {
			provider: session.provider,
			state: session.state,
			status: session.status,
			hasCode: Boolean(code),
			hasToken: Boolean(token),
			error: error || undefined,
		})
		return { success: true, provider: session.provider, state: session.state, message: session.message }
	}

	private async completeOAuthCallbackSession(session: OAuthCallbackSession) {
		if (session.status === "error") {
			return { success: false, message: session.message || session.error || "OAuth callback failed." }
		}

		if (!session.token && session.code && session.tokenExchange) {
			await this.exchangeOAuthCodeForToken(session)
		}

		if (session.token) {
			return this.persistOAuthTokenSession(session)
		}

		return {
			success: false,
			provider: session.provider,
			authStatus: session.status,
			message: session.message || "OAuth callback did not provide a token.",
		}
	}

	private async exchangeOAuthCodeForToken(session: OAuthCallbackSession) {
		if (!session.code || !session.tokenExchange) {
			return
		}

		const exchange = session.tokenExchange
		const body = new URLSearchParams()
		body.set("grant_type", "authorization_code")
		body.set("code", session.code)
		body.set("redirect_uri", session.callbackUrl)
		body.set("client_id", exchange.clientId)
		if (exchange.clientSecret && exchange.authMethod !== "client_secret_basic") {
			body.set("client_secret", exchange.clientSecret)
		}
		if (exchange.scope) {
			body.set("scope", exchange.scope)
		}
		if (exchange.codeVerifier) {
			body.set("code_verifier", exchange.codeVerifier)
		}

		const headers: Record<string, string> = {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		}
		if (exchange.clientSecret && exchange.authMethod === "client_secret_basic") {
			headers.authorization = `Basic ${Buffer.from(`${exchange.clientId}:${exchange.clientSecret}`).toString("base64")}`
		}

		logInteraction("sidecar", "oauthTokenExchangeStarted", {
			provider: session.provider,
			state: session.state,
			tokenUrl: redactUrl(exchange.tokenUrl),
			authMethod: exchange.authMethod || "client_secret_post",
		})

		const response = await fetch(exchange.tokenUrl, { method: "POST", headers, body })
		const text = await response.text()
		const parsed = asRecord(tryParseJson(text) ?? {})
		if (!response.ok) {
			const error = getString(parsed, "error_description") || getString(parsed, "error") || truncateText(text, 500)
			throw new Error(`Token endpoint returned HTTP ${response.status}: ${error || response.statusText}`)
		}

		const accessToken = getString(parsed, "access_token") || getString(parsed, "token")
		if (!accessToken) {
			throw new Error("Token endpoint response did not include access_token.")
		}

		const expiresIn = getNumber(parsed, "expires_in")
		session.token = accessToken
		session.refreshToken = getString(parsed, "refresh_token") || undefined
		session.tokenType = getString(parsed, "token_type") || undefined
		session.expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined
		session.tokenResponse = parsed
		session.status = "received"
		session.message = "OAuth token exchange completed. Saving credential for LIG VS."
		logInteraction("sidecar", "oauthTokenExchangeCompleted", {
			provider: session.provider,
			state: session.state,
			hasRefreshToken: Boolean(session.refreshToken),
			expiresIn: expiresIn || undefined,
		})
	}

	private async persistOAuthTokenSession(session: OAuthCallbackSession) {
		const field = providerCredentialField(session.provider)
		if (field) {
			const result = await this.saveProviderCredential({ provider: session.provider, value: session.token, source: "oauth_callback" })
			session.status = "configured"
			session.message = getString(result, "message") || "OAuth credential was saved."
			return result
		}

		if (isOAuthTokenBlobProvider(session.provider)) {
			const credentials = {
				provider: session.provider,
				accessToken: session.token,
				refreshToken: session.refreshToken || undefined,
				tokenType: session.tokenType || undefined,
				expiresAt: session.expiresAt || undefined,
				receivedAt: Date.now(),
				tokenResponse: session.tokenResponse || undefined,
			}
			this.state.apiConfiguration = normalizeApiConfiguration({
				...this.state.apiConfiguration,
				[oauthCredentialsField(session.provider)]: JSON.stringify(credentials),
			}) as typeof this.state.apiConfiguration
			if (normalizeProviderValue(session.provider) === "openai-codex") {
				this.state.openAiCodexIsAuthenticated = true
			}
			this.syncActiveApiConfigurationProfile()
			savePersistedState(this.state)
			await this.broadcastState()
			session.status = "configured"
			session.message = `${providerAuthLabel(session.provider)} OAuth credential was saved to local LIG VS settings.`
			logInteraction("sidecar", "oauthTokenBlobSaved", {
				provider: session.provider,
				state: session.state,
				hasRefreshToken: Boolean(session.refreshToken),
			})
			return {
				success: true,
				provider: session.provider,
				authStatus: "configured",
				isAuthenticated: true,
				hasCredential: true,
				message: session.message,
			}
		}

		session.status = "received"
		session.message = `${providerAuthLabel(session.provider)} OAuth token was received, but LIG VS has no credential storage mapping for this provider yet.`
		return {
			success: false,
			provider: session.provider,
			authStatus: "unsupported",
			hasToken: true,
			message: session.message,
		}
	}

	private clearOAuthCredential(provider: string) {
		const field = oauthCredentialsField(provider)
		const next = { ...this.state.apiConfiguration } as Record<string, unknown>
		delete next[field]
		this.state.apiConfiguration = normalizeApiConfiguration(next) as typeof this.state.apiConfiguration
		this.syncActiveApiConfigurationProfile()
	}

	private getOAuthCallbackStatus(message: unknown) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || "account")
		const state = getString(request, "state")
		const session = (state && this.oauthCallbackSessions.get(state)) || this.latestOAuthCallbackSession(provider)
		if (!session) {
			return {
				success: false,
				provider,
				authStatus: "unauthenticated",
				message: "No OAuth callback request is pending for this provider.",
			}
		}

		return {
			success: true,
			provider: session.provider,
			state: session.state,
			callbackUrl: session.callbackUrl,
			authorizationUrl: session.authorizationUrl || undefined,
			redirectUrl: session.callbackUrl,
			authStatus: session.status,
			hasCode: Boolean(session.code),
			hasToken: Boolean(session.token),
			error: session.error || undefined,
			message: session.message || "",
			tokenExchangeSupported: session.tokenExchangeSupported === true,
		}
	}

	private async submitOAuthCallback(message: unknown) {
		const request = asRecord(message)
		const callbackUrl = getString(request, "callbackUrl") || getString(request, "url") || getString(request, "value")
		if (!callbackUrl) {
			return { success: false, message: "OAuth callback URL is required.", authStatus: "unknown" }
		}

		let parsedUrl: URL
		try {
			parsedUrl = new URL(callbackUrl)
		} catch {
			return { success: false, message: "OAuth callback URL is invalid.", authStatus: "unknown" }
		}
		const result = this.recordOAuthCallbackFromUrl(parsedUrl)
		const hashParams = parseUrlFragmentParams(parsedUrl)
		const provider = normalizeProviderValue(parsedUrl.searchParams.get("provider") || hashParams.get("provider") || getString(request, "provider") || "account")
		const session = this.latestOAuthCallbackSession(provider)
		if (result.success && session) {
			const completion = await this.completeOAuthCallbackSession(session)
			return {
				...this.getOAuthCallbackStatus({ provider, state: session.state }),
				...completion,
				success: typeof completion.success === "boolean" ? completion.success : result.success,
				message: getString(completion, "message") || result.message,
			}
		}

		return {
			...this.getOAuthCallbackStatus({ provider, state: session?.state }),
			success: result.success,
			message: result.message,
		}
	}

	private latestOAuthCallbackSession(provider: string) {
		const normalizedProvider = normalizeProviderValue(provider) || "account"
		return Array.from(this.oauthCallbackSessions.values())
			.filter((session) => session.provider === normalizedProvider)
			.sort((left, right) => right.createdAt - left.createdAt)[0]
	}

	private pruneOAuthCallbackSessions() {
		const cutoff = Date.now() - readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_TTL_MS", 15 * 60 * 1000)
		for (const [state, session] of this.oauthCallbackSessions) {
			if (session.createdAt < cutoff) {
				this.oauthCallbackSessions.delete(state)
			}
		}
	}

	private async saveProviderCredential(message: unknown) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || getString(request, "apiProvider"))
		if (!provider) {
			return { success: false, message: "Provider is required.", authStatus: "unknown" }
		}

		const credential = extractProviderCredentialValue(request)
		if (!credential) {
			return { success: false, provider, message: "Credential value is required.", authStatus: "unauthenticated" }
		}

		const field = providerCredentialField(provider)
		if (!field) {
			return {
				success: false,
				provider,
				message: `${providerAuthLabel(provider)} credential storage is not mapped for the Visual Studio host yet.`,
				authStatus: "unsupported",
			}
		}

		const update: Record<string, unknown> = {
			[field]: credential,
		}
		const baseUrl = getString(request, "baseUrl") || getString(request, "url") || getString(request, "endpoint")
		const baseUrlField = providerBaseUrlField(provider)
		if (baseUrl && baseUrlField) {
			update[baseUrlField] = baseUrl
		}

		this.state.apiConfiguration = normalizeApiConfiguration({
			...this.state.apiConfiguration,
			...update,
		}) as typeof this.state.apiConfiguration
		this.syncActiveApiConfigurationProfile()
		savePersistedState(this.state)
		await this.broadcastState()

		logInteraction("sidecar", "providerCredentialSaved", {
			provider,
			field,
			hasBaseUrl: Boolean(baseUrl && baseUrlField),
			source: getString(request, "source") || undefined,
		})

		return {
			success: true,
			provider,
			authStatus: "configured",
			isAuthenticated: true,
			field,
			hasCredential: true,
			message: `${providerAuthLabel(provider)} credential was saved to local LIG VS settings.`,
		}
	}

	private getProviderCredentialStatus(message: unknown) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || getString(request, "apiProvider"))
		if (!provider) {
			return { success: false, message: "Provider is required.", authStatus: "unknown" }
		}

		const field = providerCredentialField(provider)
		const baseUrlField = providerBaseUrlField(provider)
		const apiConfig = asRecord(this.state.apiConfiguration)
		const credential = field ? getString(apiConfig, field) : ""
		const oauthCredentials = resolveOAuthCredentials(apiConfig, provider)
		const hasOAuthCredential = Object.keys(oauthCredentials).length > 0
		const oauthState = describeOAuthCredentialState(oauthCredentials)
		const envCredential = resolveProviderEnvApiKey(provider)
		const baseUrl = (baseUrlField ? getString(apiConfig, baseUrlField) : "") || resolveProviderEnvBaseUrl(provider)
		return {
			success: true,
			provider,
			supported: Boolean(field) || isOAuthTokenBlobProvider(provider),
			authStatus: credential || hasOAuthCredential ? "configured" : envCredential ? "environment" : field || isOAuthTokenBlobProvider(provider) ? "unauthenticated" : "unsupported",
			isAuthenticated: Boolean(credential || hasOAuthCredential || envCredential),
			hasCredential: Boolean(credential || hasOAuthCredential),
			hasOAuthCredential,
			oauthExpiresAt: oauthState.expiresAt,
			oauthRefreshStatus: oauthState.refreshStatus,
			oauthRefreshSupported: oauthState.refreshSupported && hasConfiguredOAuthTokenExchange(provider),
			oauthRefreshRequired: oauthState.refreshStatus === "expired",
			hasEnvironmentCredential: Boolean(envCredential),
			field: field || (isOAuthTokenBlobProvider(provider) ? oauthCredentialsField(provider) : undefined),
			baseUrl: baseUrl || undefined,
			baseUrlField: baseUrlField || undefined,
			sdkProviderId: normalizeSdkProviderId(provider),
		}
	}

	private async refreshOAuthCredential(message: unknown) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || getString(request, "apiProvider"))
		if (!provider) {
			return { success: false, message: "Provider is required.", authStatus: "unknown" }
		}
		if (!["openai-codex", "oca", "account", "lig"].includes(provider)) {
			return {
				success: false,
				provider,
				authStatus: "unsupported",
				message: `${providerAuthLabel(provider)} OAuth refresh is not required for this Visual Studio deployment scope.`,
			}
		}

		const credentials = resolveOAuthCredentials(asRecord(this.state.apiConfiguration), provider)
		const refreshToken = getString(credentials, "refreshToken") || getString(credentials, "refresh_token")
		if (!refreshToken) {
			return {
				...this.getProviderCredentialStatus({ provider }),
				success: false,
				message: `${providerAuthLabel(provider)} has no stored refresh token.`,
			}
		}
		const tokenExchange = createOAuthTokenExchangeConfig(provider, request)
		if (!tokenExchange) {
			return {
				...this.getProviderCredentialStatus({ provider }),
				success: false,
				message: `${providerAuthLabel(provider)} refresh requires a configured token endpoint and client id.`,
			}
		}

		const refreshed = await refreshOAuthToken(provider, refreshToken, tokenExchange)
		const merged = {
			...credentials,
			...refreshed,
			provider,
			refreshToken: getString(refreshed, "refreshToken") || refreshToken,
			receivedAt: Date.now(),
		}
		this.state.apiConfiguration = normalizeApiConfiguration({
			...this.state.apiConfiguration,
			[oauthCredentialsField(provider)]: JSON.stringify(merged),
		}) as typeof this.state.apiConfiguration
		if (provider === "openai-codex") {
			this.state.openAiCodexIsAuthenticated = true
		}
		this.syncActiveApiConfigurationProfile()
		savePersistedState(this.state)
		await this.broadcastState()
		logInteraction("sidecar", "oauthTokenRefreshed", {
			provider,
			expiresAt: numberValue(merged.expiresAt) || undefined,
			hasRefreshToken: Boolean(getString(merged, "refreshToken")),
		})
		return {
			...this.getProviderCredentialStatus({ provider }),
			success: true,
			authStatus: "configured",
			message: `${providerAuthLabel(provider)} OAuth credential was refreshed.`,
		}
	}

	private async getProviderConfigFields(message: unknown) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || getString(request, "apiProvider"))
		if (!provider) {
			return { success: false, message: "Provider is required.", authStatus: "unknown" }
		}

		const sdkProviderId = normalizeSdkProviderId(provider)
		const credentialStatus = this.getProviderCredentialStatus({ provider })
		try {
			const sdk = await import("@cline/sdk")
			const fields =
				typeof sdk.getProviderConfigFields === "function"
					? sdk.getProviderConfigFields(sdkProviderId)
					: createFallbackProviderConfigFields(provider)
			const fieldsRecord = asRecord(fields)
			const authMethod = getString(fieldsRecord, "authMethod") || "api-key"
			const supportsLocalCredential = Boolean(providerCredentialField(provider))
			const supported = authMethod === "oauth" ? isOAuthBridgeProvider(provider) : authMethod === "api-key" ? supportsLocalCredential : true
			const message =
				authMethod === "oauth"
					? hasConfiguredOAuthTokenExchange(provider)
						? `${providerAuthLabel(provider)} uses OAuth in the upstream SDK. LIG VS can open configured authorization URLs, receive localhost callback redirects, exchange authorization codes at the configured token endpoint, and store local OAuth credentials.`
						: `${providerAuthLabel(provider)} uses OAuth in the upstream SDK. LIG VS can receive localhost callback redirects; set provider OAuth token endpoint and client metadata to enable local token exchange.`
					: authMethod === "local"
						? `${providerAuthLabel(provider)} is a local/provider-managed auth flow. LIG VS will report readiness but does not fake sign-in.`
						: `${providerAuthLabel(provider)} can be configured with local credentials in LIG VS settings.`

			return {
				...credentialStatus,
				success: true,
				provider,
				sdkProviderId,
				supported,
				authMethod,
				fields: fieldsRecord.fields || {},
				description: getString(fieldsRecord, "description"),
				callbackSupported: authMethod === "oauth" ? isOAuthBridgeProvider(provider) : undefined,
				authorizationUrlSupported: authMethod === "oauth" ? hasConfiguredOAuthAuthorizationUrl(provider) : undefined,
				tokenExchangeSupported: authMethod === "oauth" ? hasConfiguredOAuthTokenExchange(provider) : undefined,
				message,
			}
		} catch (error) {
			const fallback = createFallbackProviderConfigFields(provider)
			return {
				...credentialStatus,
				success: true,
				provider,
				sdkProviderId,
				supported: Boolean(providerCredentialField(provider)),
				authMethod: fallback.authMethod,
				fields: fallback.fields,
				message: `Using fallback provider auth metadata for ${providerAuthLabel(provider)} because SDK provider metadata could not be loaded.`,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}

	private async clearProviderCredential(message: unknown) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || getString(request, "apiProvider"))
		if (!provider) {
			return { success: false, message: "Provider is required.", authStatus: "unknown" }
		}

		const field = providerCredentialField(provider)
		if (!field) {
			return { success: false, provider, message: `${providerAuthLabel(provider)} credential storage is not mapped.`, authStatus: "unsupported" }
		}

		const nextConfig = { ...asRecord(this.state.apiConfiguration) }
		delete nextConfig[field]
		if (request.clearBaseUrl === true) {
			const baseUrlField = providerBaseUrlField(provider)
			if (baseUrlField) {
				delete nextConfig[baseUrlField]
			}
		}
		this.state.apiConfiguration = normalizeApiConfiguration(nextConfig) as typeof this.state.apiConfiguration
		this.syncActiveApiConfigurationProfile()
		savePersistedState(this.state)
		await this.broadcastState()

		logInteraction("sidecar", "providerCredentialCleared", { provider, field })
		return {
			success: true,
			provider,
			authStatus: "unauthenticated",
			isAuthenticated: false,
			hasCredential: false,
			message: `${providerAuthLabel(provider)} credential was removed from local LIG VS settings.`,
		}
	}

	private async getPrimaryWorkspaceRoot() {
		const workspaceRoots = await VisualStudioHostProvider.create(this.connection).workspaceClient.getWorkspacePaths({}).catch(() => [])
		return workspaceRoots[0] || String(this.state.currentTaskItem?.cwdOnTaskInitialization || process.cwd())
	}

	private async runGit(args: string[], cwd: string) {
		try {
			const result = await execFile("git", args, {
				cwd,
				windowsHide: true,
				timeout: 60_000,
				maxBuffer: 1024 * 1024 * 8,
			})
			return { success: true, stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 }
		} catch (error) {
			const record = asRecord(error)
			return {
				success: false,
				stdout: getString(record, "stdout"),
				stderr: getString(record, "stderr") || getString(record, "message"),
				exitCode: getNumber(record, "code") ?? 1,
			}
		}
	}

	private async isGitAvailable() {
		const result = await this.runGit(["--version"], process.cwd())
		return result.success
	}

	private async getGitRoot(workspaceRoot = "") {
		const root = workspaceRoot || (await this.getPrimaryWorkspaceRoot())
		if (!root || !fs.existsSync(root)) {
			return { workspaceRoot: root, gitRoot: "", error: "No workspace root is available.", errorKind: "workspace_missing" }
		}

		if (!(await this.isGitAvailable())) {
			return { workspaceRoot: root, gitRoot: "", error: "Git is not available on PATH.", errorKind: "git_missing" }
		}

		const result = await this.runGit(["rev-parse", "--show-toplevel"], root)
		if (!result.success) {
			return { workspaceRoot: root, gitRoot: "", error: result.stderr || "Workspace is not a git repository.", errorKind: "repo_missing" }
		}

		return { workspaceRoot: root, gitRoot: result.stdout.trim(), error: "", errorKind: "" }
	}

	private async listWorktrees() {
		const { workspaceRoot, gitRoot, error, errorKind } = await this.getGitRoot()
		if (!gitRoot) {
			this.setWorktreesFeatureFlag(false)
			logInteraction("sidecar", "worktreeListFailed", { errorKind, error })
			return {
				worktrees: [],
				items: [],
				isGitRepo: false,
				isMultiRoot: false,
				isSubfolder: false,
				gitRootPath: "",
				error,
				errorKind,
			}
		}

		const result = await this.runGit(["worktree", "list", "--porcelain"], gitRoot)
		if (!result.success) {
			this.setWorktreesFeatureFlag(false)
			logInteraction("sidecar", "worktreeListFailed", {
				errorKind: "worktree_list_failed",
				gitRoot,
				stderr: truncateText(result.stderr, 1000),
			})
			return {
				worktrees: [],
				items: [],
				isGitRepo: true,
				isMultiRoot: false,
				isSubfolder: !samePath(gitRoot, workspaceRoot),
				gitRootPath: gitRoot,
				error: result.stderr || "Failed to list git worktrees.",
				errorKind: "worktree_list_failed",
			}
		}

		const currentRoot = await this.getCurrentGitRoot(gitRoot)
		const worktrees = await Promise.all(
			parseGitWorktreePorcelain(result.stdout).map(async (worktree) => this.enrichWorktree(worktree, currentRoot || gitRoot)),
		)
		this.setWorktreesFeatureFlag(true)
		logInteraction("sidecar", "worktreeListSucceeded", { gitRoot, count: worktrees.length })
		return {
			worktrees,
			items: worktrees,
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: !samePath(gitRoot, workspaceRoot),
			gitRootPath: gitRoot,
			error: "",
			errorKind: "",
		}
	}

	private async enrichWorktree(worktree: Record<string, unknown>, currentRoot: string) {
		const worktreePath = getString(worktree, "path")
		const status = worktreePath ? await this.getWorktreeStatus(worktreePath) : { dirty: false, statusSummary: "" }
		return {
			...worktree,
			...status,
			isCurrent: samePath(worktreePath, currentRoot),
		}
	}

	private async getWorktreeStatus(worktreePath: string) {
		if (!worktreePath || !fs.existsSync(worktreePath)) {
			return { dirty: false, statusSummary: "missing", statusEntries: [], conflictCount: 0 }
		}

		const status = await this.runGit(["status", "--porcelain"], worktreePath)
		if (!status.success) {
			return { dirty: false, statusSummary: status.stderr || "status unavailable", statusEntries: [], conflictCount: 0 }
		}

		const lines = status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
		if (lines.length === 0) {
			return { dirty: false, statusSummary: "clean", statusEntries: [], conflictCount: 0 }
		}

		const staged = lines.filter((line) => line[0] && line[0] !== "?" && line[0] !== " ").length
		const unstaged = lines.filter((line) => line[1] && line[1] !== " ").length
		const untracked = lines.filter((line) => line.startsWith("??")).length
		const conflicted = lines.filter((line) => /^([ADU]{2}|DD|AA|DU|UD|UA|AU)$/.test(line.slice(0, 2))).length
		const statusEntries = lines.slice(0, 50).map((line) => ({
			code: line.slice(0, 2),
			path: line.slice(3).trim() || line,
		}))
		const parts = [
			`${lines.length} change${lines.length === 1 ? "" : "s"}`,
			staged ? `${staged} staged` : "",
			unstaged ? `${unstaged} unstaged` : "",
			untracked ? `${untracked} untracked` : "",
			conflicted ? `${conflicted} conflict${conflicted === 1 ? "" : "s"}` : "",
		].filter(Boolean)
		return { dirty: true, statusSummary: parts.join(", "), statusEntries, conflictCount: conflicted }
	}

	private async getCurrentGitRoot(fallbackRoot: string) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		const current = await this.getGitRoot(workspaceRoot)
		return current.gitRoot || fallbackRoot
	}

	private setWorktreesFeatureFlag(enabled: boolean) {
		const current = asRecord(this.state.worktreesEnabled)
		this.state.worktreesEnabled = {
			...current,
			user: current.user !== false,
			featureFlag: enabled,
		}
	}

	private async getWorktreeDefaults() {
		const { workspaceRoot, gitRoot } = await this.getGitRoot()
		const root = gitRoot || workspaceRoot || process.cwd()
		const branchResult = await this.runGit(["branch", "--show-current"], root)
		const baseBranch = branchResult.success ? branchResult.stdout.trim() : ""
		const branches = await this.getLocalBranchCandidates(root)
		const baseBranches = await this.getBaseBranchCandidates(root)
		const rootName = path.basename(root.replace(/[\\/]+$/, "")) || "worktree"
		const parent = path.dirname(root)
		return {
			branch: "",
			baseBranch,
			currentBranch: baseBranch,
			branches,
			baseBranches,
			cwd: root,
			suggestedBranch: `feature/${rootName}-task`,
			suggestedPath: path.join(parent, `${rootName}-worktree`),
			recommendedPath: path.join(parent, `${rootName}-worktree`),
		}
	}

	private async getLocalBranchCandidates(root: string) {
		const result = await this.runGit(["branch", "--format=%(refname:short)"], root)
		if (!result.success) {
			return []
		}
		return uniqueSortedLines(result.stdout)
	}

	private async getBaseBranchCandidates(root: string) {
		const result = await this.runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], root)
		if (!result.success) {
			return this.getLocalBranchCandidates(root)
		}
		return uniqueSortedLines(result.stdout).filter((branch) => !/\/HEAD$/.test(branch))
	}

	private async getWorktreeIncludeStatus() {
		const { workspaceRoot, gitRoot } = await this.getGitRoot()
		const root = gitRoot || workspaceRoot
		const worktreeIncludePath = root ? path.join(root, ".worktreeinclude") : ""
		const gitignorePath = root ? path.join(root, ".gitignore") : ""
		return {
			enabled: !!root,
			included: !!worktreeIncludePath && fs.existsSync(worktreeIncludePath),
			exists: !!worktreeIncludePath && fs.existsSync(worktreeIncludePath),
			hasGitignore: !!gitignorePath && fs.existsSync(gitignorePath),
			gitignoreContent: gitignorePath && fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "",
		}
	}

	private async createWorktreeInclude(message: unknown) {
		const { workspaceRoot, gitRoot } = await this.getGitRoot()
		const root = gitRoot || workspaceRoot
		if (!root) {
			return { success: false, message: "No workspace root is available to create .worktreeinclude." }
		}

		const targetPath = path.join(root, ".worktreeinclude")
		fs.writeFileSync(targetPath, getString(message, "content"), "utf8")
		return { success: true, message: ".worktreeinclude created successfully.", path: targetPath }
	}

	private async createWorktree(message: unknown) {
		const request = asRecord(message)
		const { gitRoot, error } = await this.getGitRoot()
		if (!gitRoot) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "no_git_root", error })
			return { success: false, message: error || "Worktrees require a git repository." }
		}

		const rawPath = getString(request, "path")
		const branch = getString(request, "branch") || getString(request, "branchName")
		if (!rawPath || !branch) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "missing_path_or_branch", gitRoot })
			return { success: false, message: "Both a worktree folder path and branch name are required." }
		}
		const targetPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(gitRoot, rawPath)
		const baseBranch = getString(request, "baseBranch") || (await this.getWorktreeDefaults()).baseBranch || "HEAD"
		logInteraction("sidecar", "worktreeCreateStarted", {
			gitRoot,
			targetPath,
			branch,
			baseBranch,
			createNewBranch: request.createNewBranch !== false,
		})
		if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/")) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "invalid_branch", branch })
			return { success: false, message: `Invalid branch name: ${branch}` }
		}
		if (fs.existsSync(targetPath)) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "target_exists", targetPath })
			return { success: false, message: `Worktree folder already exists: ${targetPath}` }
		}
		const existingList = await this.listWorktrees()
		const existingWorktree = existingList.worktrees.find((item: Record<string, unknown>) => samePath(getString(item, "path"), targetPath))
		if (existingWorktree) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "registered_target_exists", targetPath })
			return { success: false, message: `A git worktree is already registered at ${targetPath}` }
		}
		if (isPathInside(targetPath, gitRoot)) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "inside_repo", targetPath, gitRoot })
			return { success: false, message: "Create the worktree outside the current repository folder." }
		}
		const parentWorktree = existingList.worktrees.find((item: Record<string, unknown>) => {
			const existingPath = getString(item, "path")
			return existingPath && isPathInside(targetPath, existingPath)
		})
		if (parentWorktree) {
			logInteraction("sidecar", "worktreeCreateFailed", {
				reason: "inside_existing_worktree",
				targetPath,
				parentWorktree: getString(parentWorktree, "path"),
			})
			return { success: false, message: `Create the worktree outside existing worktree folders. Parent worktree: ${getString(parentWorktree, "path")}` }
		}
		const branchExists = await this.branchExists(gitRoot, branch)
		if (request.createNewBranch !== false && branchExists) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "branch_exists", branch })
			return { success: false, message: `Branch already exists: ${branch}. Choose existing-branch mode or enter a new branch name.` }
		}
		if (request.createNewBranch === false && !branchExists) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "branch_missing", branch })
			return { success: false, message: `Branch does not exist: ${branch}. Choose new-branch mode or create the branch first.` }
		}

		const args = ["worktree", "add"]
		if (request.createNewBranch !== false) {
			args.push("-b", branch)
		} else {
			args.push("--checkout")
		}
		args.push(targetPath, request.createNewBranch === false ? branch : baseBranch)
		const result = await this.runGit(args, gitRoot)
		if (!result.success) {
			logInteraction("sidecar", "worktreeCreateFailed", { reason: "git_failed", stderr: truncateText(result.stderr, 1000) })
			return { success: false, message: classifyWorktreeGitError(result.stderr, "create") }
		}

		await this.copyWorktreeIncludeFiles(gitRoot, targetPath)
		const list = await this.listWorktrees()
		const worktree = list.worktrees.find((item: Record<string, unknown>) => samePath(getString(item, "path"), targetPath))
		logInteraction("sidecar", "worktreeCreateSucceeded", { targetPath, branch, baseBranch })
		return { success: true, message: `Worktree created for ${branch} at ${targetPath}.`, worktree, worktrees: list.worktrees }
	}

	private async branchExists(gitRoot: string, branch: string) {
		const local = await this.runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], gitRoot)
		return local.success
	}

	private async copyWorktreeIncludeFiles(gitRoot: string, targetPath: string) {
		const includePath = path.join(gitRoot, ".worktreeinclude")
		if (!fs.existsSync(includePath)) {
			return
		}
		const entries = fs
			.readFileSync(includePath, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"))
		for (const entry of entries) {
			const source = path.resolve(gitRoot, entry)
			const destination = path.resolve(targetPath, entry)
			if (!isPathInside(source, gitRoot) || !isPathInside(destination, targetPath) || !fs.existsSync(source)) {
				continue
			}
			fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: false })
		}
	}

	private async switchWorktree(message: unknown) {
		const request = asRecord(message)
		const requestedPath = getString(request, "path")
		if (!requestedPath) {
			logInteraction("sidecar", "worktreeSwitchFailed", { reason: "missing_path" })
			return { success: false, message: "Worktree path is required." }
		}
		const targetPath = path.resolve(requestedPath)
		if (!fs.existsSync(targetPath)) {
			logInteraction("sidecar", "worktreeSwitchFailed", { reason: "missing_folder", targetPath })
			return { success: false, message: `Worktree folder does not exist: ${targetPath}` }
		}

		const solutionCandidates = findSolutions(targetPath)
		if (solutionCandidates.length > 1 && !getString(request, "solutionPath")) {
			logInteraction("sidecar", "worktreeSwitchNeedsSolutionChoice", { targetPath, count: solutionCandidates.length })
			return {
				success: false,
				message: "Multiple .sln files were found. Choose a solution to open.",
				path: targetPath,
				solutionCandidates,
			}
		}
		const requestedSolution = getString(request, "solutionPath")
		const solution = requestedSolution && solutionCandidates.some((candidate) => samePath(candidate, requestedSolution))
			? requestedSolution
			: solutionCandidates[0] || ""
		if (!solution) {
			logInteraction("sidecar", "worktreeSwitchFolderFallbackStarted", { targetPath, newWindow: request.newWindow === true })
			const folderResult = asRecord(await VisualStudioHostProvider.create(this.connection).workspaceClient.openFolder({
				folderPath: targetPath,
				newWindow: request.newWindow === true,
			}))
			return {
				success: folderResult.success !== false,
				message: getString(folderResult, "message") ||
					(request.newWindow === true
						? `Folder-only worktree opened in a new Visual Studio window: ${targetPath}`
						: `Folder-only worktree opened in this Visual Studio window: ${targetPath}`),
				path: targetPath,
				workspacePath: targetPath,
				folderOnly: true,
				folderOpenFallback: true,
				solutionCandidates: [],
			}
		}

		logInteraction("sidecar", "worktreeSwitchStarted", { targetPath, solution, newWindow: request.newWindow === true })
		const hostResult = asRecord(await VisualStudioHostProvider.create(this.connection).workspaceClient.openSolution({
			solutionPath: solution,
			newWindow: request.newWindow === true,
		}))
		if (hostResult.success === false) {
			logInteraction("sidecar", "worktreeSwitchFailed", {
				reason: "host_failed",
				targetPath,
				solution,
				message: getString(hostResult, "message"),
			})
			return {
				success: false,
				message: getString(hostResult, "message") || "Visual Studio could not open the selected worktree solution.",
				path: targetPath,
				solutionPath: solution,
				solutionCandidates,
			}
		}
		logInteraction("sidecar", "worktreeSwitchSucceeded", { targetPath, solution, newWindow: request.newWindow === true })
		return {
			success: true,
			message: request.newWindow === true
				? `Worktree opened in a new Visual Studio window: ${solution}`
				: `Worktree opened in this Visual Studio window: ${solution}`,
			path: targetPath,
			workspacePath: targetPath,
			solutionPath: solution,
			solutionCandidates,
		}
	}

	private async deleteWorktree(message: unknown) {
		const request = asRecord(message)
		const { gitRoot, error } = await this.getGitRoot()
		if (!gitRoot) {
			logInteraction("sidecar", "worktreeDeleteFailed", { reason: "no_git_root", error })
			return { success: false, message: error || "Worktrees require a git repository." }
		}

		const requestedPath = getString(request, "path")
		if (!requestedPath) {
			logInteraction("sidecar", "worktreeDeleteFailed", { reason: "missing_path", gitRoot })
			return { success: false, message: "Worktree path is required." }
		}
		const targetPath = path.resolve(requestedPath)
		const force = request.force === true
		logInteraction("sidecar", "worktreeDeleteStarted", {
			gitRoot,
			targetPath,
			force,
			deleteBranch: request.deleteBranch === true,
			branchName: getString(request, "branchName"),
		})
		const status = await this.getWorktreeStatus(targetPath)
		if (!force && status.dirty) {
			logInteraction("sidecar", "worktreeDeleteFailed", { reason: "dirty", targetPath, statusSummary: status.statusSummary })
			return { success: false, message: `Cannot delete a worktree with uncommitted changes (${status.statusSummary}). Commit/stash changes or retry with force.`, dirty: true, statusSummary: status.statusSummary }
		}

		const removeArgs = ["worktree", "remove"]
		if (force) {
			removeArgs.push("--force")
		}
		removeArgs.push(targetPath)
		const removed = await this.runGit(removeArgs, gitRoot)
		if (!removed.success) {
			logInteraction("sidecar", "worktreeDeleteFailed", { reason: "git_failed", targetPath, stderr: truncateText(removed.stderr, 1000) })
			return { success: false, message: classifyWorktreeGitError(removed.stderr, "delete") }
		}

		const branchName = getString(request, "branchName")
		if (request.deleteBranch === true && branchName) {
			const deleted = await this.runGit(["branch", "-D", branchName], gitRoot)
			if (!deleted.success) {
				logInteraction("sidecar", "worktreeDeleteBranchFailed", {
					targetPath,
					branchName,
					stderr: truncateText(deleted.stderr, 1000),
				})
				return { success: true, warning: deleted.stderr || branchName, message: `Worktree deleted, but branch deletion failed: ${deleted.stderr || branchName}` }
			}
		}

		logInteraction("sidecar", "worktreeDeleteSucceeded", { targetPath, branchName: branchName || undefined })
		return { success: true, message: `Worktree deleted: ${targetPath}.`, ...(await this.listWorktrees()) }
	}

	private async mergeWorktree(message: unknown) {
		const request = asRecord(message)
		const { gitRoot, error } = await this.getGitRoot()
		if (!gitRoot) {
			logInteraction("sidecar", "worktreeMergeFailed", { reason: "no_git_root", error })
			return { success: false, message: error || "Worktrees require a git repository.", hasConflicts: false, conflictingFiles: [] }
		}

		const requestedPath = getString(request, "worktreePath") || getString(request, "path")
		if (!requestedPath) {
			logInteraction("sidecar", "worktreeMergeFailed", { reason: "missing_path", gitRoot })
			return { success: false, message: "Worktree path is required.", hasConflicts: false, conflictingFiles: [] }
		}
		const worktreePath = path.resolve(requestedPath)
		const targetBranch = getString(request, "targetBranch") || (await this.getWorktreeDefaults()).baseBranch || "main"
		const sourceBranch = await this.getBranchForWorktree(worktreePath)
		logInteraction("sidecar", "worktreeMergeStarted", {
			sourceWorktreePath: worktreePath,
			sourceBranch,
			targetWorktreePath: gitRoot,
			targetBranch,
			deleteAfterMerge: request.deleteAfterMerge === true,
		})
		if (!sourceBranch) {
			logInteraction("sidecar", "worktreeMergeFailed", { reason: "source_branch_missing", worktreePath })
			return { success: false, message: "Cannot merge a detached or unknown worktree branch.", hasConflicts: false, conflictingFiles: [] }
		}

		const sourceStatus = await this.getWorktreeStatus(worktreePath)
		if (sourceStatus.dirty) {
			logInteraction("sidecar", "worktreeMergeFailed", { reason: "source_dirty", worktreePath, statusSummary: sourceStatus.statusSummary })
			return { success: false, message: `Cannot merge while the source worktree has uncommitted changes (${sourceStatus.statusSummary}).`, hasConflicts: false, conflictingFiles: [], sourceBranch, targetBranch }
		}

		const rootStatus = await this.getWorktreeStatus(gitRoot)
		if (rootStatus.dirty) {
			logInteraction("sidecar", "worktreeMergeFailed", { reason: "target_dirty", gitRoot, statusSummary: rootStatus.statusSummary })
			return { success: false, message: `Cannot merge while the target worktree has uncommitted changes (${rootStatus.statusSummary}).`, hasConflicts: false, conflictingFiles: [], sourceBranch, targetBranch }
		}

		const checkout = await this.runGit(["checkout", targetBranch], gitRoot)
		if (!checkout.success) {
			logInteraction("sidecar", "worktreeMergeFailed", { reason: "checkout_failed", targetBranch, stderr: truncateText(checkout.stderr, 1000) })
			return {
				success: false,
				message: classifyWorktreeGitError(checkout.stderr || `Failed to checkout ${targetBranch}.`, "merge"),
				hasConflicts: false,
				conflictingFiles: [],
				sourceBranch,
				targetBranch,
				sourceWorktreePath: worktreePath,
				targetWorktreePath: gitRoot,
			}
		}

		const merge = await this.runGit(["merge", "--no-ff", sourceBranch], gitRoot)
		if (!merge.success) {
			const conflicts = await this.getConflictFiles(gitRoot)
			const recoveryCommands = [
				"git status --short",
				"git diff --name-only --diff-filter=U",
				"git merge --abort",
				`git checkout ${targetBranch}`,
			]
			logInteraction("sidecar", "worktreeMergeFailed", {
				reason: conflicts.length > 0 ? "conflict" : "merge_failed",
				sourceBranch,
				targetBranch,
				conflictCount: conflicts.length,
				stderr: truncateText(merge.stderr, 1000),
			})
			return {
				success: false,
				message: merge.stderr || "Merge failed.",
				hasConflicts: conflicts.length > 0,
				conflictingFiles: conflicts,
				recoveryState: conflicts.length > 0 ? "merge_conflict" : "merge_failed",
				recoveryCommands,
				recoveryPrompt: `Merge conflict while merging ${sourceBranch} from ${worktreePath} into ${targetBranch} at ${gitRoot}. Conflicts: ${conflicts.join(", ") || "(unknown)"}.`,
				sourceBranch,
				targetBranch,
				sourceWorktreePath: worktreePath,
				targetWorktreePath: gitRoot,
			}
		}

		let warning = ""
		if (request.deleteAfterMerge === true) {
			const deleteResult = asRecord(await this.deleteWorktree({ path: worktreePath, force: false, deleteBranch: false }))
			if (deleteResult.success === false) {
				warning = getString(deleteResult, "message") || "Merge succeeded, but the source worktree could not be deleted."
			}
		}

		logInteraction("sidecar", "worktreeMergeSucceeded", { sourceBranch, targetBranch, warning: warning || undefined })
		return {
			success: true,
			message: warning ? `Merged ${sourceBranch} into ${targetBranch}. ${warning}` : `Merged ${sourceBranch} into ${targetBranch}.`,
			hasConflicts: false,
			conflictingFiles: [],
			sourceBranch,
			targetBranch,
			sourceWorktreePath: worktreePath,
			targetWorktreePath: gitRoot,
			warning,
		}
	}

	private async getBranchForWorktree(worktreePath: string) {
		const list = await this.listWorktrees()
		const match = list.worktrees.find((item: Record<string, unknown>) => samePath(getString(item, "path"), worktreePath))
		return getString(match, "branch")
	}

	private async getConflictFiles(gitRoot: string) {
		const result = await this.runGit(["diff", "--name-only", "--diff-filter=U"], gitRoot)
		return result.success
			? result.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean)
			: []
	}

	private async recoverWorktreeMerge(message: unknown) {
		const request = asRecord(message)
		const action = normalizeMergeRecoveryAction(getString(request, "action") || getString(request, "value") || "status")
		const requestedPath = getString(request, "targetWorktreePath") || getString(request, "workspacePath") || getString(request, "path")
		const { gitRoot, error } = await this.getGitRoot(requestedPath)
		if (!gitRoot) {
			return { success: false, action, message: error || "Worktrees require a git repository.", conflictingFiles: [] }
		}

		if (action === "abort") {
			const result = await this.runGit(["merge", "--abort"], gitRoot)
			return {
				success: result.success,
				action,
				message: result.success ? "Merge aborted." : result.stderr || "Failed to abort merge.",
				conflictingFiles: await this.getConflictFiles(gitRoot),
				targetWorktreePath: gitRoot,
			}
		}

		if (action === "continue") {
			const result = await this.runGit(["merge", "--continue"], gitRoot)
			return {
				success: result.success,
				action,
				message: result.success ? "Merge continued." : result.stderr || "Failed to continue merge.",
				conflictingFiles: await this.getConflictFiles(gitRoot),
				targetWorktreePath: gitRoot,
			}
		}

		const status = await this.getWorktreeStatus(gitRoot)
		return {
			success: true,
			action: "status",
			message: status.statusSummary || "Merge status loaded.",
			statusSummary: status.statusSummary,
			statusEntries: status.statusEntries,
			conflictingFiles: await this.getConflictFiles(gitRoot),
			targetWorktreePath: gitRoot,
		}
	}

	private requireClineSdk() {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}
		return this.clineSdk
	}

	private async getMcpServersResponse() {
		return this.requireClineSdk().getMcpServersResponse()
	}

	private grpcMcpServersMutation(requestId: string, response: unknown) {
		return grpcHandled(
			grpcResponse(requestId, response, false),
			...this.buildMcpServerStreamMessages(response),
		)
	}

	private buildMcpServerStreamMessages(response: unknown) {
		return [...this.mcpServerStreamRequestIds]
			.filter((streamRequestId) => streamRequestId)
			.map((streamRequestId) => grpcResponse(streamRequestId, response, true))
	}

	private getMcpMarketplaceResponse() {
		const catalog = { items: [] }
		return { catalog, items: catalog.items }
	}

	private async openMcpSettingsFile() {
		const filePath = await this.requireClineSdk().getMcpSettingsPath()
		await VisualStudioHostProvider.create(this.connection).windowClient.openFile({ filePath })
	}

	private clearLiveInteractionState(reason: string) {
		const hadState =
			!!this.pendingApproval ||
			!!this.pendingQuestion ||
			!!this.activePartialTextTs ||
			!!this.activeReasoningTextTs ||
			!!this.activeToolActivityTs ||
			this.activeToolActivityEntries.length > 0 ||
			!!this.activeAssistantTextBuffer ||
			!!this.activeFoldedReasoningText ||
			!!this.activeFoldedActivityText ||
			!!this.activeTerminalActivityText ||
			!!this.terminalStateTimer

		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.stopTerminalStatePolling()
		this.pendingApproval?.resolve({ approved: false, reason: `Cleared by ${reason}.` })
		this.pendingApproval = null
		this.pendingQuestion?.resolve("")
		this.pendingQuestion = null
		this.activePartialTextTs = null
		this.activeAssistantTextBuffer = ""
		this.activeReasoningTextTs = null
		this.activeFoldedReasoningText = ""
		this.activeFoldedActivityText = ""
		this.activeTerminalActivityText = ""
		this.activeProgressPhase = null
		this.activeToolActivityTs = null
		this.activeToolActivityEntries = []

		if (hadState) {
			logInteraction("sidecar", "clearedLiveInteractionState", { reason })
		}
	}

	private async startNewTask(message: unknown, options: { broadcast?: boolean; requestId?: string } = {}) {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const text = getString(message, "text")
		const images = getStringArray(message, "images")
		const files = getStringArray(message, "files")
		const requestedWorkspacePath = getString(message, "workspacePath") || getString(message, "cwd") || getString(message, "worktreePath")
		const initialCwd = requestedWorkspacePath && fs.existsSync(requestedWorkspacePath)
			? path.resolve(requestedWorkspacePath)
			: process.cwd()
		const taskItem = createHistoryItem(createId(), text, initialCwd, this.getModelId())
		this.startSendLatencyTrace(options.requestId || createId(), "newTask", String(taskItem.id || ""), text.length)
		if (requestedWorkspacePath) {
			;(taskItem as Record<string, unknown>).workspacePath = initialCwd
			;(taskItem as Record<string, unknown>).worktreePath = initialCwd
		}

		this.state.clineMessages = []
		this.lastToolSummaries = []
		this.activeAssistantTextBuffer = ""
		this.activeToolActivityTs = null
		this.activeToolActivityEntries = []
		this.activeReasoningTextTs = null
		this.activeFoldedReasoningText = ""
		this.activeFoldedActivityText = ""
		this.activeTerminalActivityText = ""
		this.activeProgressPhase = null
		this.state.currentTaskItem = taskItem
		this.state.taskHistory = [taskItem, ...this.state.taskHistory.filter((item) => item.id !== taskItem.id)]
		this.addMessage({ type: "say", say: "task", text, images, files })
		this.upsertFoldedReasoningText(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다.")
		this.noteTaskActivity("start")
		this.updateCurrentTaskItem()
		this.schedulePersistedStateSave()
		if (options.broadcast !== false) {
			this.broadcastState().catch((error) => console.error(error))
		}

		void this.prepareAndLaunchNewTask({
			text,
			images,
			files,
			requestedWorkspacePath,
			initialCwd,
			taskItem,
		})
	}

	private async prepareAndLaunchNewTask({
		text,
		images,
		files,
		requestedWorkspacePath,
		initialCwd,
		taskItem,
	}: {
		text: string
		images: string[]
		files: string[]
		requestedWorkspacePath: string
		initialCwd: string
		taskItem: Record<string, unknown>
	}) {
		if (!this.clineSdk) {
			return
		}

		let cwd = initialCwd
		try {
			const workspaceRoots = await VisualStudioHostProvider.create(this.connection).workspaceClient.getWorkspacePaths({})
			cwd = requestedWorkspacePath && fs.existsSync(requestedWorkspacePath)
				? path.resolve(requestedWorkspacePath)
				: workspaceRoots[0] || initialCwd
			taskItem.cwdOnTaskInitialization = cwd
			if (requestedWorkspacePath) {
				taskItem.workspacePath = cwd
				taskItem.worktreePath = cwd
			}
			this.updateCurrentTaskItem()
			this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.activeReasoningTextTs))
			const previousActiveSessionId = this.clineSdk.status.activeSessionId
			if (previousActiveSessionId) {
				this.closingSessionIds.add(previousActiveSessionId)
				await this.clineSdk.stop({ sessionId: previousActiveSessionId }).catch((error) => {
					logInteraction("sidecar", "startNewTask.stopPreviousFailed", {
						sessionId: previousActiveSessionId,
						error: error instanceof Error ? error.message : String(error),
					})
				})
			}
			void this.runLifecycleHooks("TaskStart", { prompt: text, cwd, files, images, sessionId: String(taskItem.id || "") })
			void this.runLifecycleHooks("UserPromptSubmit", { prompt: text, cwd, files, images, sessionId: String(taskItem.id || "") })
			await this.launchSdkStartSession({
				prompt: text,
				cwd,
				userImages: normalizeSdkImageInputs(images),
				userFiles: files,
				interactive: true,
			}, cwd, String(taskItem.id || ""), "startSession")
		} catch (error) {
			this.clearTaskIdleWatchdog()
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
			this.updateCurrentTaskItem()
			await this.broadcastState()
		}
	}

	private async launchSdkStartSession(
		params: Record<string, unknown>,
		cwd: string,
		sessionId: string,
		source: string,
	) {
		if (!this.clineSdk) {
			return
		}

		let runGeneration = 0
		try {
			const config = await this.buildSdkConfig(cwd, sessionId)
			this.markSendLatencySdkSend(sessionId)
			runGeneration = ++this.sdkRunGeneration
			const result = await this.clineSdk.startSession({
				...params,
				config,
				toolPolicies: createToolPolicies(this.state.autoApprovalSettings, this.state.browserSettings, this.state.mode),
			})
			this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision
			await this.completeFromSdkResult(result, sessionId, source, runGeneration)
		} catch (error) {
			if (runGeneration && runGeneration !== this.sdkRunGeneration) {
				logInteraction("sidecar", "ignoredSupersededSdkError", {
					source,
					sessionId,
					runGeneration,
					currentRunGeneration: this.sdkRunGeneration,
					error: error instanceof Error ? error.message : String(error),
				})
				return
			}
			this.clearTaskIdleWatchdog()
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
			this.updateCurrentTaskItem()
			await this.broadcastState()
		}
	}

	private async sendAskResponse(message: unknown, requestId = createId()) {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const responseType = getString(message, "responseType")
		const text = buildTaskInputWithAttachments(getString(message, "text"), getStringArray(message, "images"), getStringArray(message, "files"))
		const activeSessionId = this.clineSdk.status.activeSessionId
		const selectedSessionId = String(this.state.currentTaskItem?.id || "")
		logInteraction("sidecar", "sendAskResponse.received", {
			responseType,
			textLength: text.length,
			hasPendingApproval: !!this.pendingApproval,
			hasPendingQuestion: !!this.pendingQuestion,
			activeSessionId,
			selectedSessionId,
		})

		if (this.pendingApproval && activeSessionId) {
			const approved = responseType === "yesButtonClicked"
			const feedback = text
			const pending = this.pendingApproval
			this.pendingApproval = null
			logInteraction("sidecar", "sendAskResponse.pendingApproval", { approved, activeSessionId })
			this.addMessage({
				type: "say",
				say: "user_feedback",
				text: feedback.trim() || (approved ? "승인됨" : "거부됨"),
				images: getStringArray(message, "images"),
				files: getStringArray(message, "files"),
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			pending.resolve({ approved, reason: feedback.trim() || (approved ? "Visual Studio에서 승인됨." : "Visual Studio에서 거부됨.") })
			return
		}

		if (this.pendingQuestion && activeSessionId) {
			const answer = getAskResponseText(message)
			const answerText = buildTaskInputWithAttachments(answer, getStringArray(message, "images"), getStringArray(message, "files"))
			const pending = this.pendingQuestion
			this.pendingQuestion = null
			logInteraction("sidecar", "sendAskResponse.pendingQuestion", { activeSessionId, answerLength: answerText.length })
			this.removeAskMessages("followup")
			this.addMessage({
				type: "say",
				say: "user_feedback",
				text: answerText.trim() || "No response.",
				images: getStringArray(message, "images"),
				files: getStringArray(message, "files"),
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			pending.resolve(answerText.trim())
			return
		}

		if (!text.trim()) {
			return
		}

		if (this.pendingApproval || this.pendingQuestion) {
			logInteraction("sidecar", "sendAskResponse.stalePendingIgnored", {
				hasPendingApproval: !!this.pendingApproval,
				hasPendingQuestion: !!this.pendingQuestion,
				activeSessionId,
				selectedSessionId,
			})
			this.pendingApproval?.resolve({ approved: false, reason: "Superseded by resumed chat message." })
			this.pendingApproval = null
			this.pendingQuestion?.resolve("")
			this.pendingQuestion = null
		}

		const sessionId = activeSessionId || selectedSessionId
		if (!sessionId) {
			logInteraction("sidecar", "sendAskResponse.startNewTask", { textLength: text.length })
			await this.startNewTask(
				{
					text: getString(message, "text"),
					images: getStringArray(message, "images"),
					files: getStringArray(message, "files"),
				},
				{ broadcast: true, requestId },
			)
			return
		}
		this.startSendLatencyTrace(requestId, "askResponse", sessionId, text.length)

		this.removeTerminalAskMessages()
		const userMessage = this.addMessage({ type: "say", say: "user_feedback", text })
		this.beginProgressPhase("reasoning")
		this.upsertFoldedReasoningText(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다.")
		this.schedulePersistedStateSave()
		this.sendPartialMessage(userMessage)
		this.broadcastState().catch((error) => console.error(error))

		const sendParams = {
			sessionId,
			prompt: getString(message, "text"),
			mode: this.state.mode === "plan" ? "plan" : "act",
			userImages: normalizeSdkImageInputs(getStringArray(message, "images")),
			userFiles: getStringArray(message, "files"),
			delivery: normalizePromptDelivery(getString(message, "delivery")),
		}
		void this.runLifecycleHooks("UserPromptSubmit", {
			prompt: getString(message, "text"),
			sessionId,
			images: getStringArray(message, "images"),
			files: getStringArray(message, "files"),
		})

		const runGeneration = ++this.sdkRunGeneration
		this.sendOrResumeSdkSession(sessionId, sendParams, text.length).then((result) =>
			this.completeFromSdkResult(result, getString(asRecord(result), "sessionId") || sessionId, "send", runGeneration),
		).catch(async (error) => {
			if (runGeneration !== this.sdkRunGeneration) {
				logInteraction("sidecar", "ignoredSupersededSdkError", {
					source: "send",
					sessionId,
					runGeneration,
					currentRunGeneration: this.sdkRunGeneration,
					error: error instanceof Error ? error.message : String(error),
				})
				return
			}
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
			await this.broadcastState()
		})
	}

	private async compactCurrentSession(requestId = createId()) {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const activeSessionId = this.clineSdk.status.activeSessionId
		const selectedSessionId = String(this.state.currentTaskItem?.id || "")
		const sessionId = activeSessionId || selectedSessionId
		if (!sessionId) {
			this.addMessage({
				type: "say",
				say: "error",
				text: this.state.uiLanguage === "en" ? "No active session to compact." : "압축할 활성 세션이 없습니다.",
			})
			await this.broadcastState()
			return
		}

		const prompt =
			this.state.uiLanguage === "en"
				? "Internal maintenance request: compact the current conversation context for future turns. Preserve the user's goals, important decisions, file paths, errors, pending tasks, and current state. Do not treat this as a user feature request."
				: "내부 유지보수 요청: 이후 대화를 위해 현재 대화 컨텍스트를 압축해 주세요. 사용자의 목표, 중요한 결정, 파일 경로, 오류, 남은 작업, 현재 상태를 보존하세요. 이것을 사용자의 일반 기능 요청으로 처리하지 마세요."

		this.startSendLatencyTrace(requestId, "askResponse", sessionId, prompt.length)
		this.beginProgressPhase("reasoning")
		this.upsertFoldedReasoningText(this.state.uiLanguage === "en" ? "Compacting context..." : "컨텍스트 압축 중입니다.")
		this.schedulePersistedStateSave()
		await this.broadcastState()

		const sendParams = {
			sessionId,
			prompt,
			mode: this.state.mode === "plan" ? "plan" : "act",
			delivery: "steer" as const,
		}

		const runGeneration = ++this.sdkRunGeneration
		try {
			const result = await this.sendOrResumeSdkSession(sessionId, sendParams, prompt.length)
			await this.completeFromSdkResult(result, getString(asRecord(result), "sessionId") || sessionId, "compact", runGeneration)
		} catch (error) {
			if (runGeneration !== this.sdkRunGeneration) {
				logInteraction("sidecar", "ignoredSupersededSdkError", {
					source: "compact",
					sessionId,
					runGeneration,
					currentRunGeneration: this.sdkRunGeneration,
					error: error instanceof Error ? error.message : String(error),
				})
				return
			}
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
			await this.broadcastState()
		}
	}

	private async sendOrResumeSdkSession(
		sessionId: string,
		sendParams: Record<string, unknown>,
		textLength: number,
	): Promise<unknown> {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		let activateMissing = false
		if (this.clineSdk.status.activeSessionId !== sessionId) {
			logInteraction("sidecar", "sendAskResponse.activateSession", {
				from: this.clineSdk.status.activeSessionId,
				to: sessionId,
			})
			await this.clineSdk.activateSession(sessionId).catch((error) => {
				if (!isSessionNotFoundError(error)) {
					throw error
				}
				activateMissing = true
				logInteraction("sidecar", "sendAskResponse.activateSessionMissing", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		}

		try {
			if (activateMissing) {
				return await this.resumeSdkSessionForSend(sessionId, sendParams, textLength)
			}
			if (this.activeSessionRuntimeSettingsRevision !== this.runtimeSettingsRevision) {
				logInteraction("sidecar", "sendAskResponse.restartForSettingsChange", {
					sessionId,
					activeSessionRuntimeSettingsRevision: this.activeSessionRuntimeSettingsRevision,
					runtimeSettingsRevision: this.runtimeSettingsRevision,
				})
				this.closingSessionIds.add(sessionId)
				await this.clineSdk.stop({ sessionId }).catch((error) => {
					logInteraction("sidecar", "sendAskResponse.stopForSettingsChangeFailed", {
						sessionId,
						error: error instanceof Error ? error.message : String(error),
					})
				})
				this.closingSessionIds.delete(sessionId)
				return await this.resumeSdkSessionForSend(sessionId, sendParams, textLength)
			}
			this.markSendLatencySdkSend(sessionId)
			logInteraction("sidecar", "sendAskResponse.sdkSend", { sessionId, textLength })
			return await this.clineSdk.send(sendParams)
		} catch (error) {
			this.markSendLatencyError(sessionId, error)
			if (!isSessionNotFoundError(error)) {
				throw error
			}
			logInteraction("sidecar", "sendAskResponse.sdkSendMissingSession", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			})
			return await this.resumeSdkSessionForSend(sessionId, sendParams, textLength)
		}
	}

	private async resumeSdkSessionForSend(
		sessionId: string,
		sendParams: Record<string, unknown>,
		textLength: number,
	): Promise<unknown> {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const workspaceRoots = await VisualStudioHostProvider.create(this.connection).workspaceClient.getWorkspacePaths({})
		const cwd = String(this.state.currentTaskItem?.cwdOnTaskInitialization || "") || workspaceRoots[0] || process.cwd()
		const prompt = getString(sendParams, "prompt")
		const userImages = getStringArray(sendParams, "userImages")
		const userFiles = getStringArray(sendParams, "userFiles")
		const taskItem = this.state.currentTaskItem || createHistoryItem(sessionId, prompt, cwd, this.getModelId())

		this.state.currentTaskItem = {
			...taskItem,
			id: sessionId,
			cwdOnTaskInitialization: cwd,
			modelId: String(taskItem.modelId || "") || this.getModelId(),
		}
		this.state.taskHistory = [
			this.state.currentTaskItem,
			...this.state.taskHistory.filter((item) => item.id !== sessionId),
		]
		this.noteTaskActivity("resume-session")
		this.updateCurrentTaskItem()
		await this.broadcastState()

		logInteraction("sidecar", "sendAskResponse.resumeStartSession", {
			sessionId,
			textLength,
			cwd,
		})
		void this.runLifecycleHooks("TaskResume", { prompt, cwd, userImages, userFiles, sessionId })
		return this.clineSdk.startSession({
			prompt: buildResumedConversationPrompt(this.state.clineMessages, prompt, this.getUiLanguage()),
			cwd,
			userImages: normalizeSdkImageInputs(userImages),
			userFiles,
			interactive: true,
			config: await this.buildSdkConfig(cwd, sessionId),
			toolPolicies: createToolPolicies(this.state.autoApprovalSettings, this.state.browserSettings, this.state.mode),
		}).then((result) => {
			this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision
			return result
		})
	}

	private async completeFromSdkResult(result: unknown, fallbackSessionId: string, source: string, runGeneration: number) {
		const resultRecord = asRecord(result)
		const sessionId = getString(resultRecord, "sessionId") || fallbackSessionId || String(this.state.currentTaskItem?.id || "")
		if (runGeneration !== this.sdkRunGeneration) {
			logInteraction("sidecar", "ignoredSupersededSdkResult", {
				source,
				sessionId,
				runGeneration,
				currentRunGeneration: this.sdkRunGeneration,
			})
			return
		}

		if (!this.isCurrentSdkResultSession(sessionId)) {
			logInteraction("sidecar", "ignoredStaleSdkResult", {
				source,
				sessionId,
				currentTaskId: this.state.currentTaskItem?.id,
				activeSessionId: this.clineSdk?.status.activeSessionId,
			})
			return
		}

		const agentResult = asRecord(resultRecord.result ?? result)
		if (Object.keys(agentResult).length === 0) {
			logInteraction("sidecar", "emptySdkResult", {
				source,
				sessionId,
				lastTaskActivityReason: this.lastTaskActivityReason,
				activePartialTextLength: this.getActivePartialText().length,
				hasAssistantTextAfterLastUserMessage: this.hasAssistantTextAfterLastUserMessage(),
			})
			const activeText = this.getActivePartialText()
			if (activeText || this.hasAssistantTextAfterLastUserMessage()) {
				this.finishSdkTask(sessionId, "completed", activeText)
				this.updateCurrentTaskItem()
				await this.broadcastState()
			}
			return
		}

		const resultText = extractCompletionTextFromResult(agentResult, resultRecord)
		const finishReason = getString(agentResult, "finishReason") || getString(agentResult, "status") || "completed"
		if (resultText) {
			this.finishSdkTask(sessionId, finishReason, resultText)
		} else if (!this.hasAssistantTextAfterLastUserMessage()) {
			logInteraction("sidecar", "emptySdkResultNoAssistantText", {
				source,
				sessionId,
				finishReason,
				lastTaskActivityReason: this.lastTaskActivityReason,
			})
			this.finishSdkTask(sessionId, finishReason)
		} else {
			this.finalizeOpenPartialMessages()
			this.addCompletionResultMarker(finishReason)
		}

		this.updateCurrentTaskItem()
		await this.broadcastState()
	}

	private async cancelTask() {
		this.sdkRunGeneration++
		const sessionIdForHook = this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
		let cancelledSessionId = ""
		if (this.clineSdk) {
			const sessionId = this.clineSdk.status.activeSessionId
			if (sessionId) {
				cancelledSessionId = sessionId
				await this.clineSdk.abort({ sessionId }).catch((error) => {
					logInteraction("sidecar", "cancelAbortFailed", {
						sessionId,
						error: error instanceof Error ? error.message : String(error),
					})
				})
			}
		}
		if (cancelledSessionId) {
			this.clineSdk?.markSessionInactive(cancelledSessionId)
		}
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		this.finalizeOpenPartialMessages()
		this.removeTerminalAskMessages()
		this.addMessage({ type: "say", say: "info", text: "현재 진행 중인 요청을 취소했습니다. 이전 대화와 세션은 유지됩니다." })
		this.updateCurrentTaskItem()
		await this.runLifecycleHooks("TaskCancel", { sessionId: sessionIdForHook })
		await this.broadcastState()
	}

	private async clearTask() {
		this.sdkRunGeneration++
		const sessionId = this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
		if (this.clineSdk && sessionId) {
			this.closingSessionIds.add(sessionId)
			await this.clineSdk.abort({ sessionId }).catch((error) => {
				logInteraction("sidecar", "clearTaskAbortFailed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
			await this.clineSdk.stop({ sessionId }).catch((error) => {
				logInteraction("sidecar", "clearTaskStopFailed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		}

		if (this.state.currentTaskItem && this.state.clineMessages.length > 0) {
			const taskId = String(this.state.currentTaskItem.id || sessionId)
			if (taskId) {
				this.rememberTaskSnapshot(taskId, this.state.currentTaskItem, this.state.clineMessages)
			}
		}

		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		this.pendingApproval?.resolve({ approved: false, reason: "Task was closed." })
		this.pendingApproval = null
		this.pendingQuestion?.resolve("")
		this.pendingQuestion = null
		this.state.currentTaskItem = null
		this.state.clineMessages = []
		savePersistedState(this.state)
		await this.broadcastState()

		this.clineSdk?.markSessionInactive(sessionId)
	}

	private async showTaskWithId(taskId: string) {
		if (String(this.state.currentTaskItem?.id || "") === taskId && this.state.clineMessages.length > 0) {
			logInteraction("sidecar", "showTaskWithId.currentStateFallback", { sessionId: taskId })
			await this.broadcastState()
			return
		}

		const snapshot = this.getTaskSnapshot(taskId)
		if (snapshot) {
			this.clearLiveInteractionState("showTaskWithId:snapshot")
			this.state.currentTaskItem = { ...snapshot.taskItem }
			this.state.clineMessages = snapshot.messages.map((message) => ({ ...message }))
			savePersistedState(this.state)
			await this.broadcastState()
			return
		}

		if (this.clineSdk && taskId) {
			this.clearLiveInteractionState("showTaskWithId")
			this.closingSessionIds.delete(taskId)
			try {
				const session = asRecord(await this.clineSdk.activateSession(taskId))
				const messages = await this.clineSdk.readMessages({ sessionId: taskId })
				const taskItem = sdkSessionToHistoryItem(session)
				const clineMessages = sdkMessagesToClineMessages(messages, taskItem)
				logInteraction("sidecar", "sdkMessagesHydrated", {
					source: "showTaskWithId",
					sessionId: taskId,
					sdkCount: Array.isArray(messages) ? messages.length : 0,
					clineCount: clineMessages.length,
					messages: clineMessages.map(summarizeClineMessageForLog),
				})
				this.state.currentTaskItem = taskItem
				this.state.clineMessages = clineMessages
				this.rememberTaskSnapshot(taskId, taskItem, this.state.clineMessages)
				savePersistedState(this.state)
				await this.broadcastState()
				return
			} catch (error) {
				if (!isSessionNotFoundError(error)) {
					throw error
				}
				logInteraction("sidecar", "showTaskWithId.sdkMissingFallback", {
					sessionId: taskId,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	private async deleteTasks(taskIds: string[]) {
		if (taskIds.length === 0) {
			return
		}

		const ids = new Set(taskIds)
		for (const id of ids) {
			this.deletedTaskIds.add(id)
			const deleted = await this.clineSdk?.deleteSession({ sessionId: id }).catch((error) => {
				logInteraction("sidecar", "deleteSessionFailed", {
					sessionId: id,
					error: error instanceof Error ? error.message : String(error),
				})
				return false
			})
			logInteraction("sidecar", "deleteSessionRequested", { sessionId: id, deleted })
			this.forgetTaskSnapshot(id)
		}
		this.state.taskHistory = removeDeletedHistoryItems(this.state.taskHistory, this.deletedTaskIds)
		if (this.state.currentTaskItem && ids.has(String(this.state.currentTaskItem.id || ""))) {
			this.clearLiveInteractionState("deleteTasks")
			this.state.currentTaskItem = null
			this.state.clineMessages = []
		}
		savePersistedState(this.state)
	}

	private async deleteAllTasks() {
		const ids = new Set(this.state.taskHistory.map((item) => String(item.id || "")).filter(Boolean))
		if (this.clineSdk) {
			const sdkHistory = await this.clineSdk.listHistory({ limit: 1000 }).catch((error) => {
				logInteraction("sidecar", "deleteAllListHistoryFailed", {
					error: error instanceof Error ? error.message : String(error),
				})
				return null
			})
			if (Array.isArray(sdkHistory)) {
				for (const session of sdkHistory) {
					const id = getString(asRecord(session), "id") || getString(asRecord(session), "sessionId")
					if (id) {
						ids.add(id)
					}
				}
			}
		}

		for (const id of ids) {
			this.deletedTaskIds.add(id)
			await this.clineSdk?.deleteSession({ sessionId: id }).catch((error) => {
				logInteraction("sidecar", "deleteAllSessionFailed", {
					sessionId: id,
					error: error instanceof Error ? error.message : String(error),
				})
				return false
			})
		}

		this.clearTaskSnapshots()
		this.state.taskHistory = []
		if (this.state.currentTaskItem && ids.has(String(this.state.currentTaskItem.id || ""))) {
			this.clearLiveInteractionState("deleteAllTasks")
			this.state.currentTaskItem = null
		}
		if (!this.state.currentTaskItem) {
			this.state.clineMessages = []
		}
		savePersistedState(this.state)
	}

	private toggleTaskFavorite(taskId: string, isFavorited: boolean) {
		if (!taskId) {
			return
		}

		this.state.taskHistory = this.state.taskHistory.map((item) =>
			item.id === taskId ? { ...item, isFavorited } : item,
		)
		const snapshot = this.getTaskSnapshot(taskId)
		if (snapshot) {
			snapshot.taskItem = { ...snapshot.taskItem, isFavorited }
			this.rememberTaskSnapshot(taskId, snapshot.taskItem, snapshot.messages)
		}
		if (this.state.currentTaskItem?.id === taskId) {
			this.state.currentTaskItem = { ...this.state.currentTaskItem, isFavorited }
		}
		savePersistedState(this.state)
		this.clineSdk?.updateSession({ sessionId: taskId, metadata: { isFavorited } }).catch(() => undefined)
	}

	private async refreshTaskHistoryFromSdk() {
		if (!this.clineSdk) {
			return
		}

		const sdkHistory = await this.clineSdk.listHistory({ limit: 200 }).catch(() => null)
		if (Array.isArray(sdkHistory)) {
			this.state.taskHistory = removeDeletedHistoryItems(
				sdkHistory.map((session) => sdkSessionToHistoryItem(asRecord(session))),
				this.deletedTaskIds,
			)
		}
	}

	private refreshTaskHistoryFromSdkInBackground(source: string) {
		if (!this.clineSdk || this.stateHydrationRefreshInFlight) {
			return
		}
		this.stateHydrationRefreshInFlight = true
		void (async () => {
			const startedAt = Date.now()
			try {
				await this.refreshTaskHistoryFromSdk()
				logInteraction("sidecar", "stateHydration.historyRefreshed", {
					source,
					durationMs: Date.now() - startedAt,
					count: this.state.taskHistory.length,
				})
				await this.broadcastState()
			} catch (error) {
				logInteraction("sidecar", "stateHydration.historyRefreshFailed", { source, error: stringify(error) })
			} finally {
				this.stateHydrationRefreshInFlight = false
			}
		})()
	}

	private async refreshSelectedTaskFromSdk() {
		if (!this.clineSdk || !this.state.currentTaskItem) {
			return
		}

		const taskId = String(this.state.currentTaskItem.id || "")
		if (!taskId) {
			return
		}

		const activeSessionId = this.clineSdk.status.activeSessionId
		if (activeSessionId && activeSessionId !== taskId) {
			return
		}
		if (this.activePartialTextTs || this.activeReasoningTextTs || this.activeToolActivityTs) {
			logInteraction("sidecar", "stateHydration.selectedTaskSkipped", {
				reason: "live_interaction",
				taskId,
				activeSessionId,
			})
			return
		}
		if (this.state.clineMessages.some((message) => message.partial === true)) {
			logInteraction("sidecar", "stateHydration.selectedTaskSkipped", {
				reason: "partial_messages",
				taskId,
				activeSessionId,
			})
			return
		}
		if (activeSessionId === taskId && this.state.clineMessages.length > 0) {
			return
		}
		if (activeSessionId === taskId && this.activePartialTextTs) {
			return
		}
		if (activeSessionId === taskId && (this.activeReasoningTextTs || this.activeToolActivityTs)) {
			return
		}

		const session = asRecord(await this.clineSdk.getSession({ sessionId: taskId }).catch(() => null))
		if (!session || Object.keys(session).length === 0) {
			return
		}

		const messages = await this.clineSdk.readMessages({ sessionId: taskId }).catch(() => null)
		if (!Array.isArray(messages)) {
			return
		}

		const taskItem = sdkSessionToHistoryItem(session)
		const clineMessages = sdkMessagesToClineMessages(messages, taskItem)
		logInteraction("sidecar", "sdkMessagesHydrated", {
			source: "refreshSelectedTaskFromSdk",
			sessionId: taskId,
			sdkCount: messages.length,
			clineCount: clineMessages.length,
			messages: clineMessages.map(summarizeClineMessageForLog),
		})
		this.state.currentTaskItem = taskItem
		this.state.clineMessages = clineMessages
		this.rememberTaskSnapshot(taskId, taskItem, this.state.clineMessages)
		this.schedulePersistedStateSave()
	}

	private async restoreCheckpoint(message: unknown) {
		if (!this.clineSdk || !this.state.currentTaskItem) {
			throw new Error("No SDK-backed task is selected for checkpoint restore.")
		}

		const checkpointRunCount =
			getNumber(message, "checkpointRunCount") ||
			getNumber(message, "runCount") ||
			findCheckpointRunCount(this.state.clineMessages, getNumber(message, "messageTs"))
		if (checkpointRunCount === undefined) {
			throw new Error("No SDK checkpoint run count is available for this restore target.")
		}

		const restoreType = getString(message, "restoreType") || "taskAndWorkspace"
		const workspaceRoots = await VisualStudioHostProvider.create(this.connection).workspaceClient.getWorkspacePaths({})
		const cwd = workspaceRoots[0] || String(this.state.currentTaskItem.cwdOnTaskInitialization || process.cwd())
		const result = await this.clineSdk.restore({
			sessionId: String(this.state.currentTaskItem.id || ""),
			checkpointRunCount,
			cwd,
			restore: {
				messages: restoreType === "task" || restoreType === "taskAndWorkspace",
				workspace: restoreType === "workspace" || restoreType === "taskAndWorkspace",
			},
			start: {
				config: await this.buildSdkConfig(cwd, String(this.state.currentTaskItem.id || "")),
				interactive: true,
				toolPolicies: createToolPolicies(this.state.autoApprovalSettings, this.state.browserSettings, this.state.mode),
			},
		})

		const restoredSessionId = getString(result, "sessionId") || getString(asRecord(result.startResult), "sessionId")
		if (restoredSessionId) {
			await this.showTaskWithId(restoredSessionId)
		} else {
			this.addMessage({ type: "say", say: "info", text: "Checkpoint workspace restore completed." })
			await this.broadcastState()
		}
	}

	private async describeCheckpointDiff(message: unknown) {
		if (!this.state.currentTaskItem) {
			return {
				success: false,
				supported: false,
				message: "No SDK-backed task is selected for checkpoint compare.",
			}
		}

		const messageTs = getNumber(message, "messageTs") || getNumber(message, "value") || getNumber(message, "number")
		const checkpointRunCount =
			getNumber(message, "checkpointRunCount") ||
			getNumber(message, "runCount") ||
			findCheckpointRunCount(this.state.clineMessages, messageTs)
		if (checkpointRunCount === undefined) {
			return {
				success: false,
				supported: false,
				message: "No SDK checkpoint run count is available for this compare target.",
			}
		}

		const checkpointMessage = findCheckpointMessage(this.state.clineMessages, checkpointRunCount, messageTs)
		const sessionId = String(this.state.currentTaskItem.id || "")
		const workspaceRoot =
			getString(checkpointMessage, "checkpointWorkspaceRoot") ||
			String(this.state.currentTaskItem.cwdOnTaskInitialization || "")
		const createdAt = numberValue(checkpointMessage?.ts)
		const createdAtText = createdAt ? new Date(createdAt).toLocaleString() : ""
		const trackedChanges = Array.from(this.pendingChangeSummaries.values()).map((change) => ({
			filePath: change.filePath,
			action: change.action,
			additions: change.additions,
			deletions: change.deletions,
			beforePath: change.beforePath,
			afterPath: change.afterPath,
		}))
		const text = [
			`Checkpoint compare requested for SDK checkpoint #${checkpointRunCount}.`,
			sessionId ? `Session: ${sessionId}` : "",
			workspaceRoot ? `Workspace: ${workspaceRoot}` : "",
			createdAtText ? `Created: ${createdAtText}` : "",
			trackedChanges.length > 0 ? `Tracked edit snapshots: ${trackedChanges.length}` : "",
			"The current SDK runtime exposes checkpoint restore metadata, but not a first-class checkpoint diff stream. Use the transcript change cards or Review controls for file-level snapshots.",
		].filter(Boolean).join("\n")

		this.addMessage({
			type: "say",
			say: "info",
			text,
			checkpointRunCount,
		})
		this.updateCurrentTaskItem()
		return {
			success: true,
			supported: true,
			checkpointRunCount,
			sessionId,
			workspaceRoot,
			comments: [
				{
					type: "sdk_checkpoint_limitation",
					message: "Checkpoint diff stream is unavailable from the current SDK runtime; Visual Studio links the compare request to stored edit snapshots.",
					trackedChanges,
				},
			],
			trackedChanges,
			text,
		}
	}

	private async refreshSdkInstructionSettings() {
		const snapshot = await this.getSdkSettingsSnapshot()
		const rules = Array.isArray(snapshot.rules) ? snapshot.rules.map(asRecord) : []
		const workflows = Array.isArray(snapshot.workflows) ? snapshot.workflows.map(asRecord) : []
		const globalClineRulesToggles = buildSettingsToggleMap(rules, "global")
		const localClineRulesToggles = buildSettingsToggleMap(rules, "local")
		const globalWorkflowToggles = buildSettingsToggleMap(workflows, "global")
		const localWorkflowToggles = buildSettingsToggleMap(workflows, "local")

		this.state.globalClineRulesToggles = globalClineRulesToggles
		this.state.localClineRulesToggles = localClineRulesToggles
		this.state.globalWorkflowToggles = globalWorkflowToggles
		this.state.localWorkflowToggles = localWorkflowToggles

		return {
			globalClineRulesToggles: { toggles: globalClineRulesToggles },
			localClineRulesToggles: { toggles: localClineRulesToggles },
			localCursorRulesToggles: { toggles: this.state.localCursorRulesToggles },
			localWindsurfRulesToggles: { toggles: this.state.localWindsurfRulesToggles },
			localAgentsRulesToggles: { toggles: this.state.localAgentsRulesToggles },
			globalWorkflowToggles: { toggles: globalWorkflowToggles },
			localWorkflowToggles: { toggles: localWorkflowToggles },
		}
	}

	private async refreshHookSettings() {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		const scripts = this.getHookScripts(workspaceRoot)
		const globalHooks = scripts
			.filter((hook) => hook.source === "global")
			.map((hook) => ({ name: hook.name, enabled: hook.enabled, absolutePath: hook.path }))
		const localHooks = scripts
			.filter((hook) => hook.source === "workspace")
			.map((hook) => ({ name: hook.name, enabled: hook.enabled, absolutePath: hook.path }))

		this.state.hooksEnabled = true
		return {
			globalHooks,
			workspaceHooks: workspaceRoot
				? [
						{
							workspaceName: path.basename(workspaceRoot),
							hooks: localHooks,
						},
					]
				: [],
		}
	}

	private async createHook(message: unknown) {
		const request = asRecord(message)
		const hookName = normalizeHookName(getString(request, "hookName") || getString(request, "name"))
		if (!hookName) {
			throw new Error("A supported hook name is required.")
		}

		const isGlobal = request.isGlobal === true
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		const directory = isGlobal ? getGlobalHooksDirectory() : getWorkspaceHooksDirectory(workspaceRoot)
		if (!directory) {
			throw new Error("No workspace is open for workspace hooks.")
		}

		fs.mkdirSync(directory, { recursive: true })
		const hookPath = findHookScript(directory, hookName)?.path || path.join(directory, `${hookName}.ps1`)
		if (!fs.existsSync(hookPath)) {
			fs.writeFileSync(hookPath, createHookScriptTemplate(hookName), "utf8")
		}
		setHookToggle(isGlobal ? "global" : "workspace", workspaceRoot, hookName, true)
		return this.refreshHookSettings()
	}

	private async deleteHook(message: unknown) {
		const request = asRecord(message)
		const hookName = normalizeHookName(getString(request, "hookName") || getString(request, "name"))
		if (!hookName) {
			throw new Error("A supported hook name is required.")
		}

		const isGlobal = request.isGlobal === true
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		const directory = isGlobal ? getGlobalHooksDirectory() : getWorkspaceHooksDirectory(workspaceRoot)
		const existing = directory ? findHookScript(directory, hookName) : null
		if (existing) {
			fs.rmSync(existing.path, { force: true })
		}
		removeHookToggle(isGlobal ? "global" : "workspace", workspaceRoot, hookName)
		return this.refreshHookSettings()
	}

	private async toggleHook(message: unknown) {
		const request = asRecord(message)
		const hookName = normalizeHookName(getString(request, "hookName") || getString(request, "name"))
		if (!hookName) {
			throw new Error("A supported hook name is required.")
		}

		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		const source = request.isGlobal === true ? "global" : "workspace"
		setHookToggle(source, workspaceRoot, hookName, request.enabled !== false)
		return this.refreshHookSettings()
	}

	private async listScheduledAgentSpecs() {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		const specs = readScheduledAgentSpecs(workspaceRoot)
		return {
			success: true,
			supported: true,
			workspaceRoot,
			specs,
			items: specs,
			recentRuns: readScheduledAgentRuns(),
			automationEnabled: this.isScheduledAgentsEnabled(),
			source: workspaceRoot ? path.join(workspaceRoot, ".cline", "cron") : "",
			message: this.isScheduledAgentsEnabled()
				? ""
				: "Scheduled agents are local-only and disabled until scheduled agents are enabled in Visual Studio settings.",
		}
	}

	private async saveScheduledAgentSpec(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		if (!workspaceRoot) {
			throw new Error("No workspace is open for scheduled agent specs.")
		}
		const spec = writeScheduledAgentSpec(workspaceRoot, asRecord(message))
		return {
			...(await this.listScheduledAgentSpecs()),
			success: true,
			supported: true,
			spec,
		}
	}

	private async deleteScheduledAgentSpec(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		if (!workspaceRoot) {
			throw new Error("No workspace is open for scheduled agent specs.")
		}
		const specId = getScheduledSpecId(asRecord(message))
		const deleted = deleteScheduledAgentSpecFile(workspaceRoot, specId)
		return {
			...(await this.listScheduledAgentSpecs()),
			success: deleted,
			supported: true,
			deleted,
			specId,
		}
	}

	private async runScheduledAgentSpec(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		if (!workspaceRoot) {
			throw new Error("No workspace is open for scheduled agent specs.")
		}
		const request = asRecord(message)
		const specId = getScheduledSpecId(request)
		const spec =
			readScheduledAgentSpecs(workspaceRoot).find((item) => getString(item, "id") === specId || getString(item, "name") === specId || getString(item, "fileName") === specId) ||
			writeScheduledAgentSpec(workspaceRoot, request)
		const prompt = getString(request, "prompt") || getString(spec, "prompt") || getString(spec, "task") || getString(spec, "text")
		if (!prompt.trim()) {
			throw new Error("Scheduled agent spec does not contain a prompt/task.")
		}
		const run = appendScheduledAgentRun({
			specId: getString(spec, "id"),
			name: getString(spec, "name"),
			workspaceRoot,
			status: "started",
			startedAt: Date.now(),
			manual: true,
		})
		await this.startNewTask({ text: prompt, workspacePath: workspaceRoot, taskSessionId: run.runId }, { broadcast: false })
		return {
			success: true,
			supported: true,
			run,
			spec,
			recentRuns: readScheduledAgentRuns(),
		}
	}

	private async getLocalPluginConfigStatus() {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot().catch(() => "")
		const plugins = discoverLocalPlugins(workspaceRoot)
		return {
			success: true,
			supported: true,
			plugins,
			items: plugins,
			count: plugins.length,
			workspaceRoot,
			marketplaceEnabled: false,
			marketplaceInstallSupported: false,
			marketplaceDisabledReason: "Air-gap Visual Studio mode only discovers local plugin configuration; online marketplace install is intentionally disabled.",
		}
	}

	private getHookScripts(workspaceRoot: string): HookScript[] {
		const scripts: HookScript[] = []
		for (const source of ["global", "workspace"] as const) {
			const directory = source === "global" ? getGlobalHooksDirectory() : getWorkspaceHooksDirectory(workspaceRoot)
			if (!directory || !fs.existsSync(directory)) {
				continue
			}

			for (const filePath of safeReadDirFiles(directory)) {
				const hookName = normalizeHookName(path.basename(filePath, path.extname(filePath)))
				if (!hookName || !isExecutableHookFile(filePath)) {
					continue
				}
				scripts.push({
					name: hookName,
					source,
					path: filePath,
					enabled: getHookToggle(source, workspaceRoot, hookName),
				})
			}
		}
		return scripts.sort((left, right) => `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`))
	}

	private async refreshSdkSkills() {
		const snapshot = await this.getSdkSettingsSnapshot()
		const skills = Array.isArray(snapshot.skills) ? snapshot.skills.map(asRecord) : []
		const globalSkills = skills.filter((item) => isGlobalSettingsItem(item)).map(settingsItemToSkillInfo)
		const localSkills = skills.filter((item) => !isGlobalSettingsItem(item)).map(settingsItemToSkillInfo)
		const globalSkillsToggles = Object.fromEntries(globalSkills.map((skill) => [skill.path, skill.enabled !== false]))
		const localSkillsToggles = Object.fromEntries(localSkills.map((skill) => [skill.path, skill.enabled !== false]))

		this.state.globalSkillsToggles = globalSkillsToggles
		this.state.localSkillsToggles = localSkillsToggles
		return { globalSkills, localSkills, globalSkillsToggles, localSkillsToggles }
	}

	private async getSdkSettingsSnapshot() {
		if (!this.clineSdk) {
			return {}
		}
		const workspaceRoots = await VisualStudioHostProvider.create(this.connection).workspaceClient.getWorkspacePaths({})
		const cwd = workspaceRoots[0] || process.cwd()
		return asRecord(await this.clineSdk.listSettings({ cwd, workspaceRoot: cwd }).catch(() => ({})))
	}

	private async toggleSdkSetting(type: "rules" | "workflows" | "skills", message: unknown) {
		if (!this.clineSdk) {
			return
		}
		const request = asRecord(message)
		const path = getString(request, "rulePath") || getString(request, "workflowPath") || getString(request, "skillPath") || getString(request, "path")
		const enabled = request.enabled === true
		const workspaceRoots = await VisualStudioHostProvider.create(this.connection).workspaceClient.getWorkspacePaths({})
		const cwd = workspaceRoots[0] || process.cwd()
		await this.clineSdk.toggleSetting({
			type,
			path,
			enabled,
			cwd,
			workspaceRoot: cwd,
		}).catch((error) => {
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
		})
	}

	private toggleFavoriteModel(modelId: string) {
		if (!modelId) {
			return
		}

		const current = new Set<string>(this.state.favoritedModelIds)
		if (current.has(modelId)) {
			current.delete(modelId)
		} else {
			current.add(modelId)
		}
		this.state.favoritedModelIds = [...current]
	}

	private applyBannerDismissal(message: unknown) {
		const banner = getString(message, "value") || getString(message, "banner") || getString(message, "id")
		const version = getNumber(message, "version") || Date.now()
		if (banner.includes("model")) {
			this.state.lastDismissedModelBannerVersion = version
		} else if (banner.includes("cli")) {
			this.state.lastDismissedCliBannerVersion = version
		} else {
			this.state.lastDismissedInfoBannerVersion = version
		}
	}

	private handleSessionChunk(payload: Record<string, unknown>) {
		const stream = getString(payload, "stream")
		const chunk = getString(payload, "chunk")
		const chunkRecord = asRecord(payload.chunk)
		if (!chunk && Object.keys(chunkRecord).length === 0) {
			return
		}

		if (stream === "agent") {
			this.noteQuietTaskActivity("chunk:agent")
			this.addAgentTranscriptChunk(payload.chunk)
			return
		}

		this.noteTaskActivity(`chunk:${stream || "unknown"}`)
		const text = truncateText(chunk, readPositiveIntEnv("VSCLINE_COMMAND_OUTPUT_CHARS", 12000))
		this.addMessage({
			type: "say",
			say: stream === "stderr" ? "command_output" : "tool",
			text,
			isCollapsed: true,
			isExpanded: false,
		})
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private addAgentTranscriptChunk(chunk: unknown) {
		const terminal = agentChunkToTerminalResult(chunk)
		if (terminal) {
			this.noteTaskActivity(terminal.reason)
			this.finishSdkTask(this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), terminal.status, terminal.text)
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
			return
		}

		const text = agentChunkToTranscriptText(chunk)
		if (!text.trim()) {
			const reasoning = agentChunkToFoldedReasoningText(chunk)
			if (reasoning.trim()) {
				this.upsertFoldedReasoningText(reasoning)
				this.updateCurrentTaskItem()
				this.schedulePartialStateBroadcast()
				return
			}
			logInteraction("sidecar", "sdkAgentChunkSkippedForUi", summarizeAgentChunkForLog(chunk))
			return
		}

		const capped = truncateText(text, readPositiveIntEnv("VSCLINE_AGENT_TRANSCRIPT_CHARS", 12000))
		if (this.isDuplicateRecentTranscript(capped)) {
			return
		}

		if (isToolTranscript(capped)) {
			this.recordToolActivity("tool", capped)
		} else {
			this.addMessage({
				type: "say",
				say: "text",
				text: capped,
			})
		}
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private isDuplicateRecentTranscript(text: string) {
		const normalized = normalizeTranscriptText(text)
		if (!normalized) {
			return true
		}

		return this.state.clineMessages.slice(-3).some((message) => normalizeTranscriptText(getString(message, "text")) === normalized)
	}

	private handleSessionSnapshot(payload: Record<string, unknown>) {
		const sessionId = getString(payload, "sessionId")
		if (sessionId) {
			this.bindCurrentTaskToSession(sessionId)
		}

		const snapshot = asRecord(payload.snapshot)
		const status = getString(snapshot, "status")
		const model = asRecord(snapshot.model)
		const aggregateUsage = asRecord(snapshot.aggregateUsage)
		const usage = normalizeUsageSnapshot(Object.keys(aggregateUsage).length > 0 ? aggregateUsage : asRecord(snapshot.usage))
		if (status === "idle") {
			this.finishSdkTask(sessionId, "completed", this.getActivePartialText())
		} else {
			this.noteTaskActivity(`session_snapshot:${status || "unknown"}`)
		}
		this.updateCurrentTaskItem({
			modelId: getString(model, "modelId") || undefined,
			tokensIn: usage.reliable ? usage.inputTokens : undefined,
			tokensOut: usage.reliable ? usage.outputTokens : undefined,
			cacheReads: usage.reliable ? usage.cacheReadTokens : undefined,
			cacheWrites: usage.reliable ? usage.cacheWriteTokens : undefined,
			totalCost: usage.reliable ? usage.totalCost : undefined,
		})
		if (status && status !== "running" && status !== "pending" && status !== "starting" && status !== "idle") {
			const activeText = this.getActivePartialText()
			this.finishSdkTask(sessionId, status, activeText)
		}
		this.broadcastState().catch((error) => console.error(error))
	}

	private handleTeamProgress(payload: Record<string, unknown>) {
		const summary = asRecord(payload.summary)
		const lifecycle = asRecord(payload.lifecycle)
		const agents = arrayOfRecords(payload.agents || payload.subagents || payload.members)
		const results = arrayOfRecords(payload.results || payload.outputs)
		const message =
			getString(summary, "message") ||
			getString(summary, "status") ||
			getString(lifecycle, "phase") ||
			getString(payload, "teamName") ||
			"Team progress updated."
		this.noteTaskActivity("team_progress")
		this.addMessage({
			type: "say",
			say: "use_subagents",
			text: JSON.stringify({
				message,
				teamId: getString(payload, "teamId") || getString(payload, "id") || undefined,
				teamName: getString(payload, "teamName") || undefined,
				phase: getString(lifecycle, "phase") || getString(payload, "phase") || undefined,
				status: getString(summary, "status") || getString(payload, "status") || undefined,
				agents: agents.map((agent) => ({
					id: getString(agent, "id") || getString(agent, "agentId"),
					name: getString(agent, "name") || getString(agent, "role"),
					status: getString(agent, "status") || getString(agent, "phase"),
					progress: getNumber(agent, "progress"),
				})),
				results: results.map((result) => ({
					id: getString(result, "id") || getString(result, "agentId"),
					status: getString(result, "status"),
					summary: truncateText(getString(result, "summary") || getString(result, "text"), 500),
				})),
			}),
			isCollapsed: true,
			isExpanded: false,
		})
		logInteraction("sidecar", "teamProgress", { message: truncateText(message, 500), agents: agents.length, results: results.length })
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private handleHookEvent(payload: Record<string, unknown>) {
		const hookEventName = getString(payload, "hookEventName")
		const toolName = getString(payload, "toolName")
		const text = JSON.stringify({
			hookEventName,
			toolName,
			agentId: getString(payload, "agentId") || undefined,
			conversationId: getString(payload, "conversationId") || undefined,
			iteration: getNumber(payload, "iteration"),
		})
		this.noteTaskActivity(`hook:${hookEventName || "unknown"}`)
		this.addMessage({ type: "say", say: "hook_status", text })
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private async runLifecycleHooks(hookName: HookLifecycleName, context: Record<string, unknown> = {}) {
		if (this.state.hooksEnabled === false) {
			return []
		}

		const workspaceRoot = await this.getPrimaryWorkspaceRoot().catch(() => "")
		const scripts = this.getHookScripts(workspaceRoot).filter((hook) => hook.name === hookName && hook.enabled)
		if (scripts.length === 0) {
			return []
		}

		const results: HookExecutionResult[] = []
		for (const hook of scripts) {
			results.push(await this.runHookScript(hook, { ...context, hookName, workspaceRoot }))
		}
		return results
	}

	private async runPreToolUseHooks(context: Record<string, unknown>): Promise<PreToolUseDecision> {
		const results = await this.runLifecycleHooks("PreToolUse", context)
		let inputDecision: PreToolUseDecision = { blocked: false, reason: "" }
		for (const result of results) {
			const decision = hookDecisionFromResponse(result.jsonResponse)
			if (decision.blocked) {
				logInteraction("sidecar", "preToolUseBlocked", {
					hookName: result.hook.name,
					scriptPath: result.hook.path,
					reason: decision.reason,
				})
				return decision
			}
			if (decision.inputPatch && Object.keys(decision.inputPatch).length > 0) {
				inputDecision = {
					blocked: false,
					reason: decision.reason || inputDecision.reason,
					inputPatch: {
						...(inputDecision.replaceInput ? {} : inputDecision.inputPatch),
						...decision.inputPatch,
					},
					replaceInput: decision.replaceInput === true || inputDecision.replaceInput === true,
					validationMessage: decision.validationMessage || inputDecision.validationMessage,
					contextPatch: mergeOptionalRecords(inputDecision.contextPatch, decision.contextPatch),
					structuredDecision: mergeOptionalRecords(inputDecision.structuredDecision, decision.structuredDecision),
				}
			} else if (decision.validationMessage || decision.contextPatch || decision.structuredDecision) {
				inputDecision = {
					...inputDecision,
					reason: decision.reason || inputDecision.reason,
					validationMessage: decision.validationMessage || inputDecision.validationMessage,
					contextPatch: mergeOptionalRecords(inputDecision.contextPatch, decision.contextPatch),
					structuredDecision: mergeOptionalRecords(inputDecision.structuredDecision, decision.structuredDecision),
				}
			}
		}
		return inputDecision
	}

	private async runHookScript(hook: HookScript, context: Record<string, unknown>): Promise<HookExecutionResult> {
		const ts = Date.now() + this.messageSequence++
		const startedMetadata = createHookMetadata(hook, "running", context)
		this.state.clineMessages.push({
			ts,
			type: "say",
			say: "hook_status",
			text: JSON.stringify(startedMetadata),
		})
		this.updateCurrentTaskItem()
		await this.broadcastState().catch((error) => console.error(error))

		const result = await executeHookScript(hook, context)
		const jsonResponse = extractHookJsonResponse(result.stdout)
		const completedMetadata = createHookMetadata(hook, result.exitCode === 0 ? "completed" : "failed", context, result, jsonResponse)
		const output = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n\n")
		this.upsertMessage(ts, {
			type: "say",
			say: "hook_status",
			text: output ? `${JSON.stringify(completedMetadata)}\n__HOOK_OUTPUT__\n${output}` : JSON.stringify(completedMetadata),
		})
		this.updateCurrentTaskItem()
		await this.broadcastState().catch((error) => console.error(error))
		return {
			hook,
			...result,
			jsonResponse,
		}
	}

	private handlePendingPrompts(payload: Record<string, unknown>) {
		const prompts = Array.isArray(payload.prompts) ? payload.prompts : []
		this.noteTaskActivity("pending_prompts")
		if (prompts.length > 0) {
			logInteraction("sidecar", "pendingPrompts", { count: prompts.length })
		}
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private handlePendingPromptSubmitted(payload: Record<string, unknown>) {
		const prompt = getString(payload, "prompt")
		this.noteTaskActivity("pending_prompt_submitted")
		if (prompt) {
			logInteraction("sidecar", "pendingPromptSubmitted", { prompt: truncateText(prompt, 160) })
		}
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private async getBrowserConnectionInfo() {
		const browserSettings = asRecord(this.state.browserSettings)
		const remoteBrowserEnabled = browserSettings.remoteBrowserEnabled === true
		const host = getString(browserSettings, "remoteBrowserHost")
		const webFetchEnabled = isWebFetchEnabled(browserSettings)
		const debugInfo = remoteBrowserEnabled ? await fetchBrowserDebugInfo(host) : null
		const executablePath = resolveBrowserExecutablePath(getString(browserSettings, "chromeExecutablePath"))
		const isConnected = remoteBrowserEnabled ? Boolean(debugInfo?.success) : Boolean(executablePath)

		return {
			isConnected,
			isRemote: remoteBrowserEnabled,
			host: remoteBrowserEnabled ? normalizeBrowserDebugHost(host) : "",
			path: remoteBrowserEnabled ? "" : executablePath,
			browser: debugInfo?.browser || "",
			protocolVersion: debugInfo?.protocolVersion || "",
			tabCount: debugInfo?.tabCount ?? 0,
			activeTabTitle: debugInfo?.activeTabTitle || "",
			activeTabUrl: debugInfo?.activeTabUrl || "",
			error: debugInfo?.error || "",
			webFetchEnabled,
			webFetchDisabledReason: webFetchDisabledReason(browserSettings),
			browserToolUseDisabled: browserSettings.disableToolUse === true,
		}
	}

	private async discoverBrowser() {
		const browserSettings = asRecord(this.state.browserSettings)
		const webFetchEnabled = isWebFetchEnabled(browserSettings)
		if (browserSettings.remoteBrowserEnabled === true) {
			const host = getString(browserSettings, "remoteBrowserHost")
			const debugInfo = await fetchBrowserDebugInfo(host)
			const success = Boolean(debugInfo.success)
			return {
				success,
				message: success
					? `Browser connection successful.${debugInfo.browser ? ` ${debugInfo.browser}` : ""}`
					: debugInfo.error || "Unable to reach the configured browser host.",
				host: normalizeBrowserDebugHost(host),
				browser: debugInfo.browser || "",
				protocolVersion: debugInfo.protocolVersion || "",
				tabCount: debugInfo.tabCount ?? 0,
				activeTabTitle: debugInfo.activeTabTitle || "",
				activeTabUrl: debugInfo.activeTabUrl || "",
				webFetchEnabled,
				webFetchDisabledReason: webFetchDisabledReason(browserSettings),
				browserToolUseDisabled: browserSettings.disableToolUse === true,
			}
		}

		const detectedPath = resolveBrowserExecutablePath(getString(browserSettings, "chromeExecutablePath"))
		return {
			success: Boolean(detectedPath),
			message: detectedPath ? `Detected browser at ${detectedPath}` : "No local Chrome or Edge executable could be found.",
			path: detectedPath,
			webFetchEnabled,
			webFetchDisabledReason: webFetchDisabledReason(browserSettings),
			browserToolUseDisabled: browserSettings.disableToolUse === true,
		}
	}

	private getBrowserAdapterConfig() {
		const browserSettings = asRecord(this.state.browserSettings)
		return {
			host: normalizeBrowserDebugHost(getString(browserSettings, "remoteBrowserHost") || "http://localhost:9222"),
			viewport: normalizeBrowserViewport(browserSettings.viewport),
			disabled: browserSettings.disableToolUse === true,
		}
	}

	private async listBrowserTabs() {
		const config = this.getBrowserAdapterConfig()
		if (config.disabled) {
			return { success: false, tabs: [], error: "Browser tool usage is disabled in Visual Studio settings." }
		}
		return listDevToolsTabs(config.host)
	}

	private async captureBrowserScreenshot(params: unknown) {
		const config = this.getBrowserAdapterConfig()
		if (config.disabled) {
			return { success: false, error: "Browser tool usage is disabled in Visual Studio settings." }
		}
		const request = asRecord(params)
		const tabId = getString(request, "tabId")
		const result = await this.runBrowserActionWithSession(config.host, {
			action: "screenshot",
			tabId,
			viewport: config.viewport,
		})
		return result
	}

	private async performBrowserAction(params: unknown) {
		const config = this.getBrowserAdapterConfig()
		const input = asRecord(params)
		if (config.disabled) {
			return { success: false, status: "error", error: "Browser tool usage is disabled in Visual Studio settings." }
		}
		return this.runBrowserActionWithSession(config.host, {
			action: normalizeBrowserActionName(getString(input, "action") || getString(input, "name") || "navigate"),
			url: getString(input, "url") || getString(input, "value"),
			tabId: getString(input, "tabId"),
			coordinate: getString(input, "coordinate"),
			text: getString(input, "text"),
			viewport: config.viewport,
		})
	}

	private async runBrowserActionWithSession(host: string, request: BrowserAdapterAction) {
		this.pruneBrowserSessions()
		const normalizedHost = normalizeBrowserDebugHost(host)
		const requestedSessionId = getString(request as unknown as Record<string, unknown>, "browserSessionId")
		const existingSession =
			(requestedSessionId && this.browserSessions.get(requestedSessionId)) ||
			Array.from(this.browserSessions.values()).find((session) => session.host === normalizedHost && (!request.tabId || session.tabId === request.tabId))
		const sessionId = existingSession?.sessionId || `browser-${createId()}`
		const actionId = `browser-action-${createId()}`
		const session: BrowserSessionRecord = existingSession || {
			sessionId,
			host: normalizedHost,
			createdAt: Date.now(),
			lastActionAt: Date.now(),
		}
		session.lastActionId = actionId
		session.lastActionAt = Date.now()
		session.lastPhase = "starting"
		this.browserSessions.set(sessionId, session)

		const phases: Array<Record<string, unknown>> = []
		const result = await runBrowserActionViaDevTools(normalizedHost, {
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
		return {
			...record,
			browserSessionId: sessionId,
			browserActionId: actionId,
			phases,
			tabId: session.tabId || getString(record, "tabId"),
			currentUrl: session.url || getString(record, "currentUrl"),
			title: session.title || getString(record, "title"),
			screenshotBytes: screenshotByteLength(getString(record, "screenshot")),
		}
	}

	private pruneBrowserSessions() {
		const maxAgeMs = readPositiveIntEnv("VSCLINE_BROWSER_SESSION_TTL_MS", 30 * 60 * 1000)
		const now = Date.now()
		for (const [sessionId, session] of this.browserSessions) {
			if (now - session.lastActionAt > maxAgeMs) {
				this.browserSessions.delete(sessionId)
			}
		}
	}

	private async handleBrowserToolEvent(toolName: string, input: Record<string, unknown>, error: string) {
		const action = normalizeBrowserActionName(getString(input, "action") || getString(input, "name") || toolName)
		const url = getString(input, "url") || getString(input, "value")
		if (action === "launch" || action === "navigate") {
			this.addMessage({ type: "say", say: "browser_action_launch", text: url || "" })
		} else {
			this.addMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify({
					action,
					coordinate: getString(input, "coordinate"),
					text: getString(input, "text"),
				}),
			})
		}

		let result: Record<string, unknown>
		if (error) {
			result = { success: false, status: "error", error }
		} else {
			result = await this.performBrowserAction({ ...input, action })
		}

		for (const phase of arrayOfRecords(result.phases)) {
			this.addMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify({
					action,
					phase: getString(phase, "phase"),
					tabId: getString(phase, "tabId"),
					browserSessionId: getString(phase, "browserSessionId"),
					browserActionId: getString(phase, "browserActionId"),
					reconnectReason: getString(phase, "reconnectReason"),
				}),
			})
		}

		this.addMessage({
			type: "say",
			say: "browser_action_result",
			text: JSON.stringify(browserActionResultForTranscript(result)),
		})
		this.updateCurrentTaskItem()
		await this.broadcastState()
	}

	private isCurrentSdkResultSession(sessionId: string) {
		if (!sessionId || this.closingSessionIds.has(sessionId) || this.deletedTaskIds.has(sessionId)) {
			return false
		}

		const currentTaskId = String(this.state.currentTaskItem?.id || "")
		return !!currentTaskId && currentTaskId === sessionId
	}

	private handleAgentEvent(event: Record<string, unknown>, sessionId = "") {
		const type = getString(event, "type")
		const contentType = getString(event, "contentType")
		let shouldBroadcastState = true
		if (sessionId) {
			this.bindCurrentTaskToSession(sessionId)
		}

		if (type === "content_start" && contentType === "text") {
			this.noteTaskActivity("content_start:text")
			this.clearReasoningStatus()
			const accumulated = getString(event, "accumulated")
			const delta = getString(event, "delta") || getString(event, "text")
			const text = accumulated || delta
			if (text) {
				if (shouldFoldTextContentAsReasoning(text)) {
					this.upsertFoldedReasoningText(text)
				} else if (!shouldDropTokenizedReasoning(text)) {
					this.upsertAssistantTextFromEvent(accumulated, delta)
				}
				shouldBroadcastState = false
			}
		}

		if (type === "content_start" && contentType === "reasoning") {
			this.noteTaskActivity("content_start:reasoning")
			const reasoning = getString(event, "reasoning") || getString(event, "text") || getString(event, "accumulated")
			this.handleReasoningDelta(reasoning)
			if (reasoning && !shouldDropTokenizedReasoning(reasoning)) {
				this.upsertFoldedReasoningText(reasoning)
			}
			shouldBroadcastState = false
		}

		if ((type === "content_update" || type === "content_delta") && contentType === "text") {
			this.noteTaskActivity(`${type}:text`)
			this.clearReasoningStatus()
			const accumulated = getString(event, "accumulated")
			const delta = getString(event, "delta") || getString(event, "text")
			const text = accumulated || delta
			if (text && shouldFoldTextContentAsReasoning(text)) {
				this.upsertFoldedReasoningText(text)
			} else if (text && !shouldDropTokenizedReasoning(text)) {
				this.upsertAssistantTextFromEvent(accumulated, delta)
			}
			shouldBroadcastState = false
		}

		if ((type === "content_update" || type === "content_delta") && contentType === "reasoning") {
			this.noteTaskActivity(`${type}:reasoning`)
			const reasoning = getString(event, "reasoning") || getString(event, "text") || getString(event, "accumulated") || getString(event, "delta")
			this.handleReasoningDelta(reasoning)
			if (reasoning && !shouldDropTokenizedReasoning(reasoning)) {
				this.upsertFoldedReasoningText(reasoning)
			}
			shouldBroadcastState = false
		}

		if (type === "content_end" && contentType === "text") {
			this.noteTaskActivity("content_end:text")
			this.clearReasoningStatus()
			const text = getString(event, "accumulated") || getString(event, "text") || this.activeAssistantTextBuffer
			if (text && shouldFoldTextContentAsReasoning(text)) {
				this.upsertFoldedReasoningText(text)
				shouldBroadcastState = false
			} else if (text && shouldDropTokenizedReasoning(text)) {
				shouldBroadcastState = false
			} else if (text && this.activePartialTextTs) {
				this.finishActiveToolActivity()
				this.finishFoldedReasoningText()
				this.upsertMessage(this.activePartialTextTs, { type: "say", say: "text", text, partial: false })
				this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.activePartialTextTs))
				this.activePartialTextTs = null
				this.activeAssistantTextBuffer = ""
			} else if (text) {
				this.finishActiveToolActivity()
				this.finishFoldedReasoningText()
				this.addMessage({ type: "say", say: "text", text })
				this.activeAssistantTextBuffer = ""
			}
		}

		if (type === "content_end" && contentType === "reasoning") {
			this.noteTaskActivity("content_end:reasoning")
			this.clearReasoningStatus()
		}

		if (type === "content_start" && contentType === "tool") {
			this.noteTaskActivity("content_start:tool")
			this.clearReasoningStatus()
			this.clearPartialIdleWatchdog()
			this.activePartialTextTs = null
			const toolName = getString(event, "toolName")
			if (toolName === "bash" || toolName === "run_commands") {
				const command = getCommandText(asRecord(event.input))
				if (command) {
					this.recordToolActivity("executeCommand", JSON.stringify({ tool: "executeCommand", command }))
				}
				this.startTerminalStatePolling()
			}
		}

		if (type === "content_end" && contentType === "tool") {
			this.noteTaskActivity("content_end:tool")
			this.clearReasoningStatus()
			const toolName = getString(event, "toolName")
			const error = getString(event, "error")
			void this.runLifecycleHooks("PostToolUse", {
				sessionId,
				toolName,
				input: event.input,
				output: event.output,
				error,
				iteration: getNumber(event, "iteration"),
			})
			const isCommand = toolName === "bash" || toolName === "run_commands"
			const input = asRecord(event.input)
			if (isCommand) {
				this.stopTerminalStatePolling()
				this.pollTerminalState().catch((pollError) =>
					logInteraction("sidecar", "terminalStateFinalPollFailed", { message: stringify(pollError) }),
				)
			}
			if (isBrowserToolName(toolName)) {
				void this.handleBrowserToolEvent(toolName, input, error)
				return
			}
			const mappedToolName = mapToolName(toolName)
			const trackedPath =
				mappedToolName === "editedExistingFile"
					? getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input) || getToolPathFromUnknown(event.output)
					: ""
			if (
				(toolName === "editor" || toolName === "edit") &&
				(this.hasRecentlyTrackedChange() || (trackedPath && this.wasRecentlyTracked(trackedPath)))
			) {
				return
			}
			const text = isCommand
				? truncateText(error || summarizeCommandOutput(event.output), readPositiveIntEnv("VSCLINE_COMMAND_OUTPUT_CHARS", 12000))
				: JSON.stringify({
						tool: mappedToolName,
						path:
							mappedToolName === "searchFiles"
								? getToolPath(input) || getToolPath(asRecord(event.output)) || "/"
								: getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input) || getToolPathFromUnknown(event.output),
						regex: mappedToolName === "searchFiles" ? getSearchQuery(input) || getSearchQuery(event.output) : undefined,
						filePattern: mappedToolName === "searchFiles" ? getSearchFilePattern(input) || getSearchFilePattern(event.output) : undefined,
						content: error || summarizeToolOutput(mappedToolName, event.output),
						error: error || undefined,
					})
			this.rememberToolSummary(mappedToolName, text)
			if (isCommand) {
				this.appendTerminalActivityText(formatCompletedCommandActivity(text, this.getUiLanguage()))
				this.moveActiveReasoningToEnd()
			} else {
				this.recordToolActivity(mappedToolName, text)
			}
		}

		if (type === "content_update" && contentType === "tool") {
			this.noteTaskActivity("content_update:tool")
			this.clearReasoningStatus()
			const rawToolName = getString(event, "toolName")
			if (rawToolName === "bash" || rawToolName === "run_commands") {
				this.startTerminalStatePolling()
			}
			const toolName = mapToolName(rawToolName)
			const update = event.update
			if (update !== undefined) {
				this.rememberToolSummary(
					toolName,
					JSON.stringify({
						tool: toolName,
						path: getToolPathFromUnknown(update),
						content: summarizeToolOutput(toolName, update),
					}),
				)
			}
		}

		if (type === "iteration_start") {
			this.noteTaskActivity("iteration_start")
		}

		if (type === "iteration_end") {
			this.noteTaskActivity("iteration_end")
			const iteration = getNumber(event, "iteration")
			const toolCallCount = getNumber(event, "toolCallCount") || 0
			const hadToolCalls = asRecord(event).hadToolCalls === true || toolCallCount > 0
			if (
				!hadToolCalls &&
				!this.hasCompletionResultAfterLastUserMessage() &&
				(this.getActivePartialText().trim() || this.hasAssistantTextAfterLastUserMessage())
			) {
				logInteraction("sidecar", "iterationEndCompletesTurn", {
					sessionId,
					iteration,
					toolCallCount,
					activePartialTextLength: this.getActivePartialText().length,
				})
				this.finishSdkTask(sessionId || String(this.state.currentTaskItem?.id || ""), "completed", this.getActivePartialText())
			}
		}

		if (type === "notice") {
			this.noteTaskActivity("notice")
			const message = getString(event, "message")
			const reason = getString(event, "reason")
			const noticeType = getString(event, "noticeType")
			if (message) {
				const text = reason ? `${message}\n\nReason: ${reason}` : message
				if (noticeType === "status") {
					logInteraction("sidecar", "sdkStatusNotice", { text })
				} else {
					this.addMessage({ type: "say", say: "text", text })
				}
			}
		}

		if (type === "tool-finished") {
			this.noteTaskActivity("tool-finished")
			this.clearReasoningStatus()
			const toolCall = asRecord(event.toolCall)
			const mappedToolName = mapToolName(getString(toolCall, "toolName"))
			const result = asRecord(event.result)
			const output = result.output ?? event.message
			const input = asRecord(toolCall.input)
			const text = JSON.stringify({
				tool: mappedToolName,
				path: getToolPathFromUnknown(input) || getToolPathFromUnknown(output),
				content: summarizeToolOutput(mappedToolName, output),
				error: result.isError === true ? summarizeToolOutput(mappedToolName, output) : undefined,
			})
			this.rememberToolSummary(mappedToolName, text)
			this.recordToolActivity(mappedToolName, text)
		}

		if (type === "assistant-message") {
			this.noteTaskActivity("assistant-message")
			this.clearReasoningStatus()
			const text = contentToText(asRecord(event.message).content)
			if (text.trim()) {
				this.finalizeActivePartialText()
				this.addMessage({ type: "say", say: "text", text })
			}
		}

		if (type === "run-finished") {
			this.noteTaskActivity("run-finished")
			this.finishActiveToolActivity()
			this.finishFoldedReasoningText()
			this.clearReasoningStatus()
			const result = asRecord(event.result)
			const usage = normalizeUsageSnapshot(asRecord(result.usage || result.aggregateUsage || event.usage))
			if (usage.reliable) {
				this.updateCurrentTaskItem({
					tokensIn: usage.inputTokens,
					tokensOut: usage.outputTokens,
					cacheReads: usage.cacheReadTokens,
					cacheWrites: usage.cacheWriteTokens,
					totalCost: usage.totalCost,
				})
			}
			const text = extractCompletionTextFromResult(result, event)
			this.finishSdkTask(sessionId, getString(result, "status") || "completed", text)
		}

		if (type === "run-failed") {
			this.noteTaskActivity("run-failed")
			this.finishActiveToolActivity()
			this.finishFoldedReasoningText()
			this.clearReasoningStatus()
			this.finishSdkTask(sessionId, "failed")
		}

		if (type === "usage") {
			this.noteTaskActivity("usage")
			const usage = asRecord(event.usage)
			const normalizedUsage = normalizeUsageSnapshot({
				...usage,
				totalInputTokens: event.totalInputTokens,
				totalOutputTokens: event.totalOutputTokens,
				totalCacheReadTokens: event.totalCacheReadTokens,
				totalCacheWriteTokens: event.totalCacheWriteTokens,
				totalCost: event.totalCost ?? usage.totalCost ?? usage.cost,
			})
			if (normalizedUsage.reliable) {
				this.updateCurrentTaskItem({
					tokensIn: normalizedUsage.inputTokens,
					tokensOut: normalizedUsage.outputTokens,
					cacheReads: normalizedUsage.cacheReadTokens,
					cacheWrites: normalizedUsage.cacheWriteTokens,
					totalCost: normalizedUsage.totalCost,
				})
			}
		}

		if (type === "done") {
			this.noteTaskActivity("done")
			this.finishFoldedReasoningText()
			this.clearReasoningStatus()
			const text = extractCompletionTextFromResult(asRecord(event.result), event)
			this.finishSdkTask(sessionId, "completed", text)
		}

		if (type === "error") {
			this.noteTaskActivity("error")
			this.finishFoldedReasoningText()
			this.clearReasoningStatus()
			const text = formatProviderErrorForTranscript(event.error, this.getUiLanguage())
			this.markSendLatencyError(sessionId, text)
			this.addMessage({ type: "say", say: "error", text })
		}

		this.updateCurrentTaskItem()
		if (shouldBroadcastState) {
			this.broadcastState().catch((error) => console.error(error))
		}
	}

	private handleReasoningDelta(text: string) {
		if (!this.state.currentTaskItem) {
			return
		}

		if (!this.reasoningStartedAt) {
			this.reasoningStartedAt = Date.now()
			logInteraction("sidecar", "reasoningStarted", { textLength: text.length })
		}

		this.reasoningChunkCount++
		const now = Date.now()
		const intervalMs = readPositiveIntEnv("VSCLINE_REASONING_STATUS_INTERVAL_MS", 2000)
		if (now - this.lastReasoningStatusAt < intervalMs) {
			return
		}

		this.lastReasoningStatusAt = now
		const elapsedSeconds = Math.max(1, Math.round((now - this.reasoningStartedAt) / 1000))
		logInteraction("sidecar", "reasoningProgress", {
			elapsedSeconds,
			chunks: this.reasoningChunkCount,
			textLength: text.length,
		})
	}

	private clearReasoningStatus() {
		this.reasoningStartedAt = 0
		this.reasoningChunkCount = 0
		this.lastReasoningStatusAt = 0
	}

	private async handleFileChangedEvent(payload: Record<string, unknown>) {
		const filePath = getString(payload, "filePath")
		const beforePath = getString(payload, "beforePath")
		const afterPath = getString(payload, "afterPath") || filePath
		if (!filePath || !beforePath || !afterPath) {
			return
		}

		const additions = getNumber(payload, "additions") || 0
		const deletions = getNumber(payload, "deletions") || 0
		const action = getString(payload, "action") || "modified"
		this.recentlyTrackedChangePaths.set(normalizeChangePath(filePath), Date.now())
		this.pruneTrackedChangePaths()

		this.queueChangeSummary({
			filePath,
			beforePath,
			afterPath,
			action,
			additions,
			deletions,
		})
	}

	private queueChangeSummary(change: TrackedChangeSummary) {
		const key = normalizeChangePath(change.filePath)
		const existing = this.pendingChangeSummaries.get(key)
		this.pendingChangeSummaries.set(key, {
			...change,
			beforePath: existing?.beforePath || change.beforePath,
			additions: (existing?.additions || 0) + change.additions,
			deletions: (existing?.deletions || 0) + change.deletions,
		})

		if (this.changeSummaryTimer) {
			clearTimeout(this.changeSummaryTimer)
		}
		this.changeSummaryTimer = setTimeout(() => {
			this.flushChangeSummary().catch((error) => console.error(error))
		}, 250)
	}

	private async flushChangeSummary() {
		this.changeSummaryTimer = null
		const files = Array.from(this.pendingChangeSummaries.values())
		this.pendingChangeSummaries.clear()
		if (files.length === 0) {
			return
		}

		const additions = files.reduce((sum, file) => sum + file.additions, 0)
		const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
		const changed = files.filter((file) => file.action !== "created" && file.action !== "deleted").length
		const created = files.filter((file) => file.action === "created").length
		const deleted = files.filter((file) => file.action === "deleted").length
		const actionParts = [
			changed ? `edited ${changed}` : "",
			created ? `created ${created}` : "",
			deleted ? `deleted ${deleted}` : "",
		].filter(Boolean)

		const text = JSON.stringify({
			tool: "vsclineChangedFiles",
			path: files[0]?.filePath || "",
			content: `LIG VS ${actionParts.join(", ") || "changed"} file${files.length > 1 ? "s" : ""}.`,
			files,
			additions,
			deletions,
		})
		this.addMessage({ type: "say", say: "tool", text })
		this.updateCurrentTaskItem()
		await this.broadcastState()
	}

	private async revertVsClineChanges(message: unknown) {
		const request = asRecord(message)
		const files = (Array.isArray(request.files) ? request.files : [])
			.map(asRecord)
			.filter((file) => getString(file, "filePath"))
		const workspaceClient = VisualStudioHostProvider.create(this.connection).workspaceClient
		const reverted: string[] = []
		const skipped: Array<{ filePath: string; reason: string }> = []

		for (const file of files) {
			const filePath = getString(file, "filePath")
			const beforePath = getString(file, "beforePath")
			const action = getString(file, "action") || "modified"
			if (!filePath) {
				continue
			}

			try {
				if (action === "created") {
					await workspaceClient.deleteFile({ path: filePath })
					reverted.push(filePath)
					continue
				}

				if (!beforePath) {
					skipped.push({ filePath, reason: "missing before snapshot" })
					continue
				}

				const before = await workspaceClient.readTextFile({ path: beforePath })
				if (!before.exists) {
					skipped.push({ filePath, reason: "before snapshot not found" })
					continue
				}

				await workspaceClient.writeTextFile({ path: filePath, content: before.content })
				reverted.push(filePath)
			} catch (error) {
				skipped.push({ filePath, reason: stringify(error) })
			}
		}

		const content =
			skipped.length > 0
				? `Reverted ${reverted.length} file${reverted.length === 1 ? "" : "s"}; skipped ${skipped.length}.`
				: `Reverted ${reverted.length} file${reverted.length === 1 ? "" : "s"}.`
		this.addMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify({
				tool: "vsclineRevertedFiles",
				path: reverted[0] || skipped[0]?.filePath || "",
				content,
				files: reverted,
				skipped,
			}),
		})
		this.updateCurrentTaskItem()
		await this.broadcastState()

		return {
			success: skipped.length === 0,
			reverted,
			skipped,
			message: content,
		}
	}

	private wasRecentlyTracked(filePath: string) {
		this.pruneTrackedChangePaths()
		return this.recentlyTrackedChangePaths.has(normalizeChangePath(filePath))
	}

	private hasRecentlyTrackedChange() {
		this.pruneTrackedChangePaths()
		return this.recentlyTrackedChangePaths.size > 0
	}

	private pruneTrackedChangePaths() {
		const cutoff = Date.now() - 15_000
		for (const [filePath, ts] of this.recentlyTrackedChangePaths) {
			if (ts < cutoff) {
				this.recentlyTrackedChangePaths.delete(filePath)
			}
		}
	}

	private async buildSdkConfig(cwd: string, sessionId?: string) {
		const apiConfig = asRecord(this.state.apiConfiguration)
		const modePrefix = this.state.mode === "plan" ? "planMode" : "actMode"
		const providerId = normalizeProviderId(getString(apiConfig, `${modePrefix}ApiProvider`) || process.env.CLINE_PROVIDER_ID || "anthropic")
		const sdkProviderId = normalizeSdkProviderId(providerId)
		const configuredBaseUrl = resolveBaseUrl(apiConfig, providerId)
		const modelLookupBaseUrl = providerId === "ollama" ? normalizeOllamaRootBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const sdkBaseUrl = providerId === "ollama" ? normalizeOllamaOpenAiBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const modelId = await this.resolveEffectiveModelId(apiConfig, providerId, modePrefix, modelLookupBaseUrl)
		const oauthCredentials = resolveOAuthCredentials(apiConfig, providerId)
		const oauthAccessToken = getString(oauthCredentials, "accessToken") || getString(oauthCredentials, "access_token")
		const apiKey = resolveApiKey(apiConfig, providerId) || oauthAccessToken || process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || ""
		const maxTokensPerTurn = readOptionalPositiveIntEnv("VSCLINE_MAX_TOKENS_PER_TURN")
		const apiTimeoutMs = resolveRequestTimeoutMs(apiConfig)
		const reasoningEffort = resolveReasoningEffort(apiConfig, modePrefix)
		const thinking = resolveThinkingEnabled(apiConfig, modePrefix, providerId, reasoningEffort)
		const contextWindowTokens = resolveConfiguredContextWindow(apiConfig, providerId, modePrefix, modelId)
		const maxIterations = readOptionalPositiveIntEnv("VSCLINE_MAX_ITERATIONS")
		const maxParallelToolCalls = readOptionalPositiveIntEnv("VSCLINE_MAX_PARALLEL_TOOL_CALLS")
		const execution = buildOptionalExecutionConfig()
		const subagentsEnabled = this.state.subagentsEnabled === true || process.env.VSCLINE_ENABLE_SUBAGENTS === "1"
		const scheduledAgentsEnabled = this.isScheduledAgentsEnabled()
		const preferredLanguage = normalizePreferredLanguage(getString(this.state, "preferredLanguage"))
		const languageInstruction =
			preferredLanguage === "Korean - 한국어"
				? "Reply to the user in Korean unless the user explicitly asks for another language."
				: "Reply to the user in English unless the user explicitly asks for another language."
		const modeInstruction =
			this.state.mode === "plan"
				? "You are in PLAN mode. Do not modify files, run terminal commands, launch browsers, or perform destructive/external actions. Use read-only inspection only when necessary, ask clarifying questions when the requested change is ambiguous, and return a concrete plan for the user to approve before implementation."
				: "You are in ACT mode. You may implement approved changes using the available Visual Studio tools while keeping actions scoped to the user's request."
		const customPrompt = getString(this.state, "customPrompt").trim()
		const systemPrompt = [
			`You are LIG VS running inside Visual Studio 2022 through the VsClineAgent SDK wrapper. ${languageInstruction} ${modeInstruction} Commands execute under Windows cmd.exe; when using cmd built-ins such as dir, type, copy, or del, use backslashes for paths or quote absolute paths.`,
			customPrompt ? `Additional user-defined instructions:\n${customPrompt}` : "",
		]
			.filter(Boolean)
			.join("\n\n")

		logInteraction("sidecar", "sdkConfig", {
			providerId: sdkProviderId,
			modelId,
			baseUrl: sdkBaseUrl || undefined,
			mode: this.state.mode,
			maxTokensPerTurn,
			apiTimeoutMs,
			thinking,
			reasoningEffort,
			contextWindowTokens,
			useAutoCondense: this.state.useAutoCondense === true,
			sessionId: sessionId || undefined,
			maxIterations,
			maxParallelToolCalls,
			subagentsEnabled,
			scheduledAgentsEnabled,
			oauthConfigured: Object.keys(oauthCredentials).length > 0,
			execution,
			preferredLanguage,
		})

		return {
			providerId: sdkProviderId,
			modelId,
			sessionId: sessionId || undefined,
			apiKey,
			baseUrl: sdkBaseUrl || undefined,
			cwd,
			workspaceRoot: cwd,
			mode: this.state.mode === "plan" ? "plan" : "act",
			enableTools: true,
			enableSpawnAgent: subagentsEnabled,
			enableAgentTeams: subagentsEnabled,
			...(maxIterations ? { maxIterations } : {}),
			...(maxParallelToolCalls ? { maxParallelToolCalls } : {}),
			...(maxTokensPerTurn ? { maxTokensPerTurn } : {}),
			...(apiTimeoutMs ? { apiTimeoutMs } : {}),
			thinking,
			reasoningEffort,
			providerConfig: {
				...(maxTokensPerTurn ? { maxTokens: maxTokensPerTurn } : {}),
				...(apiTimeoutMs ? { timeout: apiTimeoutMs } : {}),
				...(Object.keys(oauthCredentials).length > 0 ? { oauthCredentials } : {}),
				reasoning: {
					enabled: thinking,
					effort: reasoningEffort,
				},
			},
			checkpoint: {
				enabled: this.state.enableCheckpointsSetting !== false,
			},
			compaction: {
				enabled: this.state.useAutoCondense === true,
				strategy: "basic",
				thresholdRatio: 0.9,
				...(contextWindowTokens ? { maxInputTokens: contextWindowTokens } : {}),
			},
			...(execution ? { execution } : {}),
			preferredLanguage,
			systemPrompt,
		}
	}

	private addAssistantTextResult(text: string) {
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		const normalizedText = normalizeAssistantTranscriptText(text || "")
		if (!normalizedText) {
			return
		}
		this.markSendLatencyFirstAssistant(this.getCurrentSessionId(), normalizedText.length)

		const lastText = [...this.state.clineMessages]
			.reverse()
			.find((message) => message.say === "text" && message.partial !== true)
		if (normalizeTranscriptText(getString(lastText, "text")) === normalizeTranscriptText(normalizedText)) {
			return
		}

		this.addMessage({ type: "say", say: "text", text: normalizedText })
	}

	private hasCompletionResult() {
		return this.state.clineMessages.some((message) => message.say === "completion_result" || message.ask === "completion_result")
	}

	private getLastUserMessageIndex() {
		return findLastIndex(
			this.state.clineMessages,
			(message) => getString(message, "say") === "user_feedback" || getString(message, "say") === "task",
		)
	}

	private hasCompletionResultAfterLastUserMessage() {
		const lastUserIndex = this.getLastUserMessageIndex()
		return this.state.clineMessages
			.slice(lastUserIndex + 1)
			.some((message) => getString(message, "say") === "completion_result" || getString(message, "ask") === "completion_result")
	}

	private getLastUserOrProgressMessageIndex() {
		return findLastIndex(this.state.clineMessages, (message) => {
			const say = getString(message, "say")
			const ask = getString(message, "ask")
			if (say === "user_feedback" || say === "task") {
				return true
			}
			if (ask === "command" || ask === "tool") {
				return true
			}
			if (say === "tool" || say === "command_output" || say === "browser_action") {
				return true
			}
			if (say === "reasoning") {
				const text = getString(message, "text")
				return text.includes("기록") || text.includes("history") || text.includes("진행") || text.includes("Running")
			}
			return false
		})
	}

	private hasAssistantTextAfterLastUserOrProgressMessage() {
		const lastBoundaryIndex = this.getLastUserOrProgressMessageIndex()
		return this.state.clineMessages
			.slice(lastBoundaryIndex + 1)
			.some((message) => getString(message, "say") === "text" && getString(message, "text").trim().length > 0 && message.partial !== true)
	}

	private finishSdkTask(sessionId: string, status: string, text = "") {
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearReasoningStatus()
		const activeText = text || this.getActivePartialText()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()

		const hasAssistantTextSinceUser = this.hasAssistantTextAfterLastUserMessage()
		const hasFinalAssistantText = this.hasAssistantTextAfterLastUserOrProgressMessage()
		if (activeText) {
			this.addAssistantTextResult(activeText)
		} else if (!hasAssistantTextSinceUser) {
			logInteraction("sidecar", "emptyDoneNoFinalAssistantText", { status, lastTaskActivityReason: this.lastTaskActivityReason })
			const normalizedStatus = String(status || "").toLowerCase()
			if (normalizedStatus === "completed" || normalizedStatus === "idle" || normalizedStatus === "ended") {
				this.finalizeOpenPartialMessages()
				savePersistedState(this.state)
				return
			}
		} else if (!hasFinalAssistantText) {
			logInteraction("sidecar", "doneWithPreviousAssistantTextNoFinalText", { status, lastTaskActivityReason: this.lastTaskActivityReason })
		} else {
			logInteraction("sidecar", "doneWithExistingAssistantText", { status, lastTaskActivityReason: this.lastTaskActivityReason })
		}
		this.finalizeOpenPartialMessages()
		this.addCompletionResultMarker(status)
		void this.runLifecycleHooks("TaskComplete", { sessionId, status, text: activeText })
		savePersistedState(this.state)
	}

	private addCompletionResultMarker(status: string) {
		if (this.hasCompletionResultAfterLastUserMessage()) {
			return
		}

		const normalizedStatus = String(status || "").toLowerCase()
		const uiLanguage = this.getUiLanguage()
		const text =
			normalizedStatus === "cancelled" || normalizedStatus === "stopped" || normalizedStatus === "aborted"
				? uiLanguage === "ko" ? "요청을 취소했습니다." : "Request cancelled."
				: normalizedStatus === "failed" || normalizedStatus === "error"
					? uiLanguage === "ko" ? "작업이 오류 상태로 종료되었습니다." : "Task ended with an error."
					: uiLanguage === "ko" ? "완료" : "Done."
		this.addMessage({ type: "say", say: "completion_result", text })
	}

	private getUiLanguage(): "en" | "ko" {
		return getString(this.state, "uiLanguage") === "en" ? "en" : "ko"
	}

	private hasAssistantTextAfterLastUserMessage() {
		const lastUserIndex = this.getLastUserMessageIndex()
		return this.state.clineMessages
			.slice(lastUserIndex + 1)
			.some((message) => getString(message, "say") === "text" && getString(message, "text").trim().length > 0 && message.partial !== true)
	}

	private buildTerminalCompletionFallback(status: string) {
		const toolSummary = this.lastToolSummaries.slice(-5).join("\n")
		if (status === "failed" || status === "error") {
			return toolSummary ? `작업이 오류 상태로 종료되었습니다.\n\n${toolSummary}` : "작업이 오류 상태로 종료되었습니다."
		}
		if (status === "stalled" || status === "idle-timeout") {
			return toolSummary
				? `LIG VS SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다.\n\n마지막으로 확인된 작업:\n${toolSummary}`
				: "LIG VS SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다."
		}
		if (status === "cancelled" || status === "stopped" || status === "aborted") {
			return toolSummary ? `작업이 중단되었습니다.\n\n${toolSummary}` : "작업이 중단되었습니다."
		}
		return toolSummary ? `작업이 완료되었습니다.\n\n${toolSummary}` : "작업이 완료되었습니다."
	}

	private rememberToolSummary(tool: string, text: string) {
		const parsed = asRecord(tryParseJson(text) ?? {})
		const pathValue = getString(parsed, "path")
		const content = getString(parsed, "content")
		const summary = [tool, pathValue, content].filter(Boolean).join(": ")
		this.lastToolSummaries.push(truncateText(summary || text, 2000))
		if (this.lastToolSummaries.length > 20) {
			this.lastToolSummaries = this.lastToolSummaries.slice(-20)
		}
	}

	private async resolveEffectiveModelId(
		apiConfig: Record<string, unknown>,
		providerId: string,
		modePrefix: string,
		baseUrl: string,
	) {
		let modelId = resolveModelId(apiConfig, providerId, modePrefix)
		if (providerId !== "ollama") {
			return modelId || process.env.CLINE_MODEL_ID || "claude-sonnet-4-6"
		}

		if (!modelId || modelId === "claude-sonnet-4-6") {
			modelId = process.env.OLLAMA_MODEL || process.env.CLINE_MODEL_ID || ""
		}

		if (!modelId || modelId === "claude-sonnet-4-6") {
			const models = await getOllamaModels(baseUrl)
			modelId = models[0] || ""
			if (modelId) {
				this.applyDefaultOllamaModel(modelId)
			}
		}

		if (!modelId || modelId === "claude-sonnet-4-6") {
			throw new Error(
				`No local Ollama model is configured. Start Ollama and pull a model, for example: ollama pull llama3.1. Base URL: ${baseUrl || "http://localhost:11434"}`,
			)
		}

		return modelId
	}

	private applySettings(message: unknown) {
		const request = asRecord(message)
		let runtimeSettingsChanged = false
		const apiConfigurationUpdate = extractApiConfigurationUpdate(request)
		if (Object.keys(apiConfigurationUpdate).length > 0) {
			this.state.apiConfiguration = normalizeApiConfiguration({
				...this.state.apiConfiguration,
				...compactApiConfiguration(apiConfigurationUpdate),
			}) as typeof this.state.apiConfiguration
			this.syncActiveApiConfigurationProfile()
			runtimeSettingsChanged = true
		}
		const autoApprovalUpdate = extractAutoApprovalSettingsUpdate(request)
		if (Object.keys(autoApprovalUpdate).length > 0) {
			this.state.autoApprovalSettings = {
				...this.state.autoApprovalSettings,
				...autoApprovalUpdate,
				actions: {
					...asRecord(this.state.autoApprovalSettings.actions),
					...asRecord(autoApprovalUpdate.actions),
				},
			}
			runtimeSettingsChanged = true
		}
		if ("browserSettings" in request) {
			this.state.browserSettings = {
				...asRecord(this.state.browserSettings),
				...asRecord(request.browserSettings),
			} as typeof this.state.browserSettings
			this.refreshWebToolFeatureState()
			runtimeSettingsChanged = true
		}
		if ("focusChainSettings" in request) {
			this.state.focusChainSettings = {
				...asRecord(this.state.focusChainSettings),
				...asRecord(request.focusChainSettings),
			} as typeof this.state.focusChainSettings
		}
		if ("mcpDisplayMode" in request) {
			this.state.mcpDisplayMode = normalizeMcpDisplayMode(request.mcpDisplayMode, this.state.mcpDisplayMode)
		}
		for (const key of [
			"apiConfiguration",
			"autoApprovalSettings",
			"mode",
			"planActSeparateModelsSetting",
			"uiLanguage",
			"preferredLanguage",
			"telemetrySetting",
			"subagentsEnabled",
			"scheduledAgentsEnabled",
			"hooksEnabled",
			"showFeatureTips",
			"backgroundEditEnabled",
			"enableCheckpointsSetting",
			"yoloModeToggled",
			"doubleCheckCompletionEnabled",
			"lazyTeammateModeEnabled",
			"mcpResponsesCollapsed",
			"enableParallelToolCalling",
			"nativeToolCallEnabled",
			"strictPlanModeEnabled",
			"useAutoCondense",
			"customPrompt",
		] as const) {
			if (key in request && key !== "apiConfiguration" && key !== "autoApprovalSettings") {
				const stateKey = key === "nativeToolCallEnabled" ? "nativeToolCallSetting" : key
				;(this.state as Record<string, unknown>)[stateKey] = request[key]
				if (isRuntimeSettingsKey(key)) {
					runtimeSettingsChanged = true
				}
			}
		}
		if ("apiConfigurationProfiles" in request) {
			this.state.apiConfigurationProfiles = normalizeApiConfigurationProfiles(request.apiConfigurationProfiles, this.state.apiConfiguration, this.state.planActSeparateModelsSetting)
			runtimeSettingsChanged = true
		}
		if ("activeApiConfigurationProfileId" in request) {
			this.activateApiConfigurationProfile(getString(request, "activeApiConfigurationProfileId"))
			runtimeSettingsChanged = true
		} else if ("apiConfigurationProfiles" in request) {
			this.ensureApiConfigurationProfileState()
		}
		if ("planActSeparateModelsSetting" in request && !("activeApiConfigurationProfileId" in request)) {
			this.syncActiveApiConfigurationProfile()
			runtimeSettingsChanged = true
		}
		if (runtimeSettingsChanged) {
			this.runtimeSettingsRevision++
			logInteraction("sidecar", "runtimeSettingsChanged", {
				runtimeSettingsRevision: this.runtimeSettingsRevision,
				activeSessionRuntimeSettingsRevision: this.activeSessionRuntimeSettingsRevision,
			})
		}
	}

	private ensureApiConfigurationProfileState() {
		const profiles = normalizeApiConfigurationProfiles(
			this.state.apiConfigurationProfiles,
			this.state.apiConfiguration,
			this.state.planActSeparateModelsSetting,
		)
		this.state.apiConfigurationProfiles = profiles
		const activeId = getString(this.state, "activeApiConfigurationProfileId")
		if (!profiles.some((profile) => getString(profile, "id") === activeId)) {
			this.state.activeApiConfigurationProfileId = getString(profiles[0], "id")
		}
	}

	private activateApiConfigurationProfile(profileId: string) {
		this.ensureApiConfigurationProfileState()
		const profiles = arrayOfRecords(this.state.apiConfigurationProfiles)
		const profile = profiles.find((candidate) => getString(candidate, "id") === profileId) || profiles[0]
		if (!profile) {
			return
		}
		this.state.activeApiConfigurationProfileId = getString(profile, "id")
		this.applyApiConfigurationProfileSnapshot(profile)
	}

	private applyApiConfigurationProfileSnapshot(profile: Record<string, unknown>) {
		const profileApiConfiguration = asRecord(profile.apiConfiguration)
		this.state.apiConfiguration = normalizeApiConfiguration(profileApiConfiguration) as typeof this.state.apiConfiguration
		this.state.planActSeparateModelsSetting =
			typeof profile.planActSeparateModelsSetting === "boolean"
				? profile.planActSeparateModelsSetting
				: this.state.planActSeparateModelsSetting
	}

	private syncActiveApiConfigurationProfile() {
		this.ensureApiConfigurationProfileState()
		const activeId = getString(this.state, "activeApiConfigurationProfileId")
		const now = new Date().toISOString()
		this.state.apiConfigurationProfiles = arrayOfRecords(this.state.apiConfigurationProfiles).map((profile) =>
			getString(profile, "id") === activeId
				? {
					...profile,
					apiConfiguration: normalizeApiConfiguration(asRecord(this.state.apiConfiguration)),
					planActSeparateModelsSetting: this.state.planActSeparateModelsSetting,
					updatedAt: now,
				}
				: profile,
		) as typeof this.state.apiConfigurationProfiles
	}

	private refreshWebToolFeatureState() {
		const enabled = isWebFetchEnabled(this.state.browserSettings)
		this.state.clineWebToolsEnabled = {
			user: enabled,
			featureFlag: enabled,
			reason: webFetchDisabledReason(this.state.browserSettings) || undefined,
		}
	}

	private applyDefaultOllamaModel(modelId: string) {
		const apiConfiguration = this.state.apiConfiguration as Record<string, unknown>
		let changed = false

		if (
			apiConfiguration.actModeApiProvider === "ollama" &&
			(typeof apiConfiguration.actModeOllamaModelId !== "string" || !apiConfiguration.actModeOllamaModelId.trim())
		) {
			apiConfiguration.actModeOllamaModelId = modelId
			changed = true
		}
		if (
			apiConfiguration.planModeApiProvider === "ollama" &&
			(typeof apiConfiguration.planModeOllamaModelId !== "string" || !apiConfiguration.planModeOllamaModelId.trim())
		) {
			apiConfiguration.planModeOllamaModelId = modelId
			changed = true
		}

		if (changed) {
			savePersistedState(this.state)
			this.broadcastState().catch((error) => console.error(error))
		}
	}

	private addMessage(message: Record<string, unknown>) {
		if (isMeaninglessPlaceholderMessage(message)) {
			logInteraction("sidecar", "skipMeaninglessPlaceholderMessage", message)
			return undefined
		}
		if (isMeaninglessTextMessage(message)) {
			logInteraction("sidecar", "skipMeaninglessTextMessage", message)
			return undefined
		}
		if (isMeaninglessToolMessage(message)) {
			logInteraction("sidecar", "skipMeaninglessToolMessage", message)
			return undefined
		}
		const normalizedMessage = {
			ts: Date.now() + this.messageSequence++,
			...normalizeClineMessagePayload(message),
		}
		this.state.clineMessages.push(normalizedMessage)
		this.schedulePersistedStateSave()
		return normalizedMessage
	}

	private removeTerminalAskMessages() {
		this.state.clineMessages = this.state.clineMessages.filter((message) => {
			const ask = getString(message, "ask")
			return ask !== "completion_result" && ask !== "resume_task" && ask !== "resume_completed_task"
		})
		this.schedulePersistedStateSave()
	}

	private removeAskMessages(askKind: string) {
		this.state.clineMessages = this.state.clineMessages.filter((message) => getString(message, "ask") !== askKind)
		this.schedulePersistedStateSave()
	}

	private addToolActivityMessage(tool: string, input: Record<string, unknown>, fallback: unknown) {
		this.recordToolActivity(
			tool,
			JSON.stringify({
				tool,
				path: tool === "searchFiles" ? getToolPath(input) || "/" : getToolPathFromUnknown(input),
				regex: tool === "searchFiles" ? getSearchQuery(input) : undefined,
				filePattern: tool === "searchFiles" ? getSearchFilePattern(input) : undefined,
				command: tool === "executeCommand" ? getCommandText(input) : undefined,
				content: summarizeToolInput(input) || stringify(fallback),
			}),
		)
	}

	private recordToolActivity(tool: string, text: string) {
		const entries = toolActivityEntriesFromMessage(tool, text)
		if (entries.length === 0) {
			return
		}

		for (const entry of entries) {
			const key = toolActivityEntryKey(entry)
			if (!this.activeToolActivityEntries.some((existing) => toolActivityEntryKey(existing) === key)) {
				this.activeToolActivityEntries.push(entry)
			}
		}

		const groupedText = buildGroupedToolActivityText(this.activeToolActivityEntries, true, this.getUiLanguage())
		this.upsertFoldedActivityText(groupedText)
		this.activeToolActivityTs = this.activeReasoningTextTs
	}

	private startTerminalStatePolling() {
		if (this.terminalStateTimer) {
			return
		}

		this.pollTerminalState().catch((error) => logInteraction("sidecar", "terminalStatePollFailed", { message: stringify(error) }))
		this.terminalStateTimer = setInterval(() => {
			this.pollTerminalState().catch((error) => logInteraction("sidecar", "terminalStatePollFailed", { message: stringify(error) }))
		}, readPositiveIntEnv("VSCLINE_TERMINAL_STATE_POLL_MS", 2500))
	}

	private stopTerminalStatePolling() {
		if (this.terminalStateTimer) {
			clearInterval(this.terminalStateTimer)
			this.terminalStateTimer = null
		}
		this.terminalStatePolling = false
	}

	private async pollTerminalState() {
		if (this.terminalStatePolling) {
			return
		}
		this.terminalStatePolling = true
		try {
			const workspace = VisualStudioHostProvider.create(this.connection).workspaceClient
			const state = asRecord(await workspace.getTerminalState({}))
			const activeCommands = Array.isArray(state.activeCommands) ? state.activeCommands.map(asRecord) : []
			const recentCommands = Array.isArray(state.recentCommands) ? state.recentCommands.map(asRecord) : []
			const outputResult = asRecord(await workspace.getUnretrievedTerminalOutput({ afterSequence: this.lastTerminalOutputSequence }))
			const lines = Array.isArray(outputResult.lines) ? outputResult.lines.map(asRecord) : []
			for (const line of lines) {
				const sequence = getNumber(line, "sequence") || 0
				if (sequence > this.lastTerminalOutputSequence) {
					this.lastTerminalOutputSequence = sequence
				}
			}

			const text = buildTerminalActivityText(activeCommands, recentCommands, lines, state, this.getUiLanguage())
			if (!text) {
				return
			}

			this.activeTerminalActivityText = text
			this.upsertFoldedProgressMessage()
			this.updateCurrentTaskItem()
		} finally {
			this.terminalStatePolling = false
		}
	}

	private finishActiveToolActivity() {
		if (!this.activeToolActivityTs && this.activeToolActivityEntries.length === 0) {
			return
		}

		const groupedText = buildGroupedToolActivityText(this.activeToolActivityEntries, false, this.getUiLanguage())
		this.upsertFoldedActivityText(groupedText)
		this.activeToolActivityTs = null
		this.activeToolActivityEntries = []
	}

	private moveActiveReasoningToEnd() {
		if (!this.activeReasoningTextTs) {
			return
		}

		const index = this.state.clineMessages.findIndex((message) => message.ts === this.activeReasoningTextTs)
		if (index < 0 || index === this.state.clineMessages.length - 1) {
			return
		}

		const [message] = this.state.clineMessages.splice(index, 1)
		this.state.clineMessages.push(message)
	}

	private finalizeActivePartialText() {
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		if (!this.activePartialTextTs) {
			return
		}
		const message = this.state.clineMessages.find((item) => item.ts === this.activePartialTextTs)
		if (message) {
			message.partial = false
			this.sendPartialMessage(message)
		}
		this.activePartialTextTs = null
	}

	private getActivePartialText() {
		if (!this.activePartialTextTs) {
			return ""
		}
		return getString(this.state.clineMessages.find((item) => item.ts === this.activePartialTextTs), "text")
	}

	private upsertPartialText(text: string) {
		let created = false
		if (!this.activePartialTextTs) {
			created = true
			this.activePartialTextTs = Date.now() + this.messageSequence++
			this.state.clineMessages.push({
				ts: this.activePartialTextTs,
				type: "say",
				say: "text",
				text,
				partial: true,
			})
		} else {
			this.upsertMessage(this.activePartialTextTs, { type: "say", say: "text", text, partial: true })
		}

		this.schedulePartialIdleWatchdog()
		if (created) {
			this.broadcastPartialStateNow()
		} else {
			this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.activePartialTextTs))
			this.schedulePartialStateBroadcast()
		}
	}

	private upsertAssistantTextFromEvent(accumulated: string, delta: string) {
		const nextText = accumulated || mergeTextDelta(this.activeAssistantTextBuffer, delta)
		const normalized = normalizeAssistantTranscriptText(nextText)
		if (!normalized) {
			return
		}
		this.markSendLatencyFirstAssistant(this.getCurrentSessionId(), normalized.length)

		this.activeAssistantTextBuffer = normalized
		if (shouldFoldTextContentAsReasoning(normalized)) {
			this.upsertFoldedReasoningText(normalized)
			return
		}
		if (!accumulated && shouldDelayAssistantTextUntilClassified(normalized)) {
			this.schedulePartialIdleWatchdog()
			this.schedulePartialStateBroadcast()
			return
		}
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		this.upsertPartialText(normalized)
	}

	private upsertFoldedReasoningText(text: string) {
		const normalized = normalizeReasoningTranscriptText(text)
		if (!normalized || isEmptyTranscriptPlaceholder(normalized)) {
			return
		}

		this.beginProgressPhase("reasoning")
		const capped = truncateText(normalized, readPositiveIntEnv("VSCLINE_REASONING_TRANSCRIPT_CHARS", 12000))
		const previous = this.activeFoldedReasoningText
		const previousNormalized = normalizeTranscriptText(previous)
		const cappedNormalized = normalizeTranscriptText(capped)
		if (previousNormalized.includes(cappedNormalized)) {
			return
		}
		if (!this.activeReasoningTextTs && this.hasRecentFoldedReasoning(capped)) {
			return
		}

		this.activeFoldedReasoningText = truncateText(
			cappedNormalized.includes(previousNormalized) ? capped : [previous, capped].filter(Boolean).join("\n"),
			readPositiveIntEnv("VSCLINE_REASONING_TRANSCRIPT_CHARS", 12000),
		)
		this.upsertFoldedProgressMessage()
	}

	private hasRecentFoldedReasoning(text: string) {
		const normalized = normalizeTranscriptText(text)
		if (!normalized) {
			return true
		}

		return this.state.clineMessages.slice(-6).some((message) => {
			if (getString(message, "say") !== "reasoning") {
				return false
			}
			const existing = normalizeTranscriptText(getString(message, "reasoning"))
			return existing === normalized || existing.includes(normalized) || normalized.includes(existing)
		})
	}

	private upsertFoldedActivityText(text: string) {
		const normalized = normalizeProgressTranscriptText(text)
		if (!normalized || isEmptyTranscriptPlaceholder(normalized)) {
			return
		}

		this.beginProgressPhase("activity")
		this.activeFoldedActivityText = truncateText(normalized, readPositiveIntEnv("VSCLINE_AGENT_TRANSCRIPT_CHARS", 12000))
		this.upsertFoldedProgressMessage()
	}

	private appendTerminalActivityText(text: string) {
		const normalized = normalizeProgressTranscriptText(text)
		if (!normalized || isEmptyTranscriptPlaceholder(normalized)) {
			return
		}

		this.beginProgressPhase("terminal")
		const previous = this.activeTerminalActivityText
		const previousNormalized = normalizeTranscriptText(previous)
		const nextNormalized = normalizeTranscriptText(normalized)
		if (previousNormalized.includes(nextNormalized)) {
			return
		}

		this.activeTerminalActivityText = truncateText(
			[nextNormalized.includes(previousNormalized) ? "" : previous, normalized].filter(Boolean).join("\n\n"),
			readPositiveIntEnv("VSCLINE_TERMINAL_ACTIVITY_CHARS", 2000),
		)
		this.upsertFoldedProgressMessage()
	}

	private beginProgressPhase(phase: ProgressPhase) {
		if (!this.activeProgressPhase) {
			this.activeProgressPhase = phase
			return
		}
		if (this.activeProgressPhase === phase) {
			return
		}

		this.finishFoldedReasoningText(false)
		this.activeFoldedReasoningText = ""
		this.activeFoldedActivityText = ""
		this.activeTerminalActivityText = ""
		this.activeProgressPhase = null
		this.activeToolActivityTs = null
		this.activeToolActivityEntries = []
		this.activeProgressPhase = phase
	}

	private upsertFoldedProgressMessage() {
		const foldedText = [
			this.activeFoldedActivityText,
			this.activeTerminalActivityText,
			this.activeFoldedReasoningText,
		]
			.filter(Boolean)
			.join("\n\n")
		if (!foldedText.trim() || isEmptyTranscriptPlaceholder(foldedText)) {
			return
		}

		let created = false
		if (!this.activeReasoningTextTs) {
			created = true
			this.activeReasoningTextTs = Date.now() + this.messageSequence++
			this.state.clineMessages.push({
				ts: this.activeReasoningTextTs,
				type: "say",
				say: "reasoning",
				text: this.getProgressPhaseTitle(),
				reasoning: foldedText,
				partial: true,
				isCollapsed: true,
				isExpanded: false,
			})
		} else {
			this.upsertMessage(this.activeReasoningTextTs, {
				type: "say",
				say: "reasoning",
				text: this.getProgressPhaseTitle(),
				reasoning: foldedText,
				partial: true,
				isCollapsed: true,
				isExpanded: false,
			})
		}

		this.moveActiveReasoningToEnd()
		const progressMessage = this.state.clineMessages.find((message) => message.ts === this.activeReasoningTextTs)
		if (created) {
			this.broadcastPartialStateNow()
		} else {
			this.sendPartialMessage(progressMessage)
			this.schedulePartialStateBroadcast()
		}
	}

	private finishFoldedReasoningText(stopTerminalPolling = true) {
		if (stopTerminalPolling) {
			this.stopTerminalStatePolling()
		}
		if (!this.activeReasoningTextTs) {
			return
		}

		const progressMessage = this.state.clineMessages.find((message) => message.ts === this.activeReasoningTextTs)
		if (isEmptyTranscriptPlaceholder(getString(progressMessage, "reasoning") || getString(progressMessage, "text"))) {
			this.upsertMessage(this.activeReasoningTextTs, {
				text: "",
				reasoning: "",
				partial: false,
				isCollapsed: true,
				isExpanded: false,
			})
			this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.activeReasoningTextTs))
			this.activeReasoningTextTs = null
			this.activeFoldedReasoningText = ""
			this.activeFoldedActivityText = ""
			this.activeTerminalActivityText = ""
			this.activeProgressPhase = null
			return
		}

		this.upsertMessage(this.activeReasoningTextTs, {
			text: this.getProgressPhaseTitle(true),
			reasoning: sanitizeProgressTranscriptForDisplay(getString(progressMessage, "reasoning")),
			partial: false,
			isCollapsed: true,
			isExpanded: false,
		})
		this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.activeReasoningTextTs))
		this.activeReasoningTextTs = null
		this.activeFoldedReasoningText = ""
		this.activeFoldedActivityText = ""
		this.activeTerminalActivityText = ""
		this.activeProgressPhase = null
	}

	private getProgressPhaseTitle(completed = false) {
		const language = this.state.uiLanguage === "en" ? "en" : "ko"
		const suffix = completed
			? language === "ko" ? " 기록" : " history"
			: language === "ko" ? " 중" : "..."
		switch (this.activeProgressPhase) {
			case "terminal":
				return language === "ko" ? `터미널 실행${suffix}` : `Running terminal${suffix}`
			case "activity":
				return language === "ko" ? `파일/도구 처리${suffix}` : `Reading files and using tools${suffix}`
			case "reasoning":
			default:
				return language === "ko" ? `응답 준비${suffix}` : `Preparing response${suffix}`
		}
	}

	private startSendLatencyTrace(requestId: string, kind: "newTask" | "askResponse", sessionId: string, textLength: number) {
		if (!sessionId) {
			return
		}
		const trace: SendLatencyTrace = {
			requestId,
			kind,
			sessionId,
			startedAt: Date.now(),
			textLength,
		}
		this.sendLatencyTraces.set(sessionId, trace)
		logInteraction("sidecar", "sendLatency.received", {
			requestId,
			kind,
			sessionId,
			textLength,
		})
	}

	private markSendLatencySdkSend(sessionId: string) {
		const trace = this.sendLatencyTraces.get(sessionId)
		if (!trace || trace.sdkSendAt) {
			return
		}
		trace.sdkSendAt = Date.now()
		logInteraction("sidecar", "sendLatency.sdkSend", this.createSendLatencyPayload(trace))
	}

	private markSendLatencyFirstSdkEvent(sessionId: string, eventType: string) {
		const trace = this.sendLatencyTraces.get(sessionId)
		if (!trace || trace.firstSdkEventAt) {
			return
		}
		trace.firstSdkEventAt = Date.now()
		logInteraction("sidecar", "sendLatency.firstSdkEvent", {
			...this.createSendLatencyPayload(trace),
			eventType,
		})
	}

	private markSendLatencyFirstAssistant(sessionId: string, textLength: number) {
		const trace = this.sendLatencyTraces.get(sessionId)
		if (!trace || trace.firstAssistantAt) {
			return
		}
		trace.firstAssistantAt = Date.now()
		logInteraction("sidecar", "sendLatency.firstAssistant", {
			...this.createSendLatencyPayload(trace),
			assistantTextLength: textLength,
		})
	}

	private markSendLatencyError(sessionId: string, error: unknown) {
		const trace = this.sendLatencyTraces.get(sessionId)
		if (!trace || trace.errorAt) {
			return
		}
		trace.errorAt = Date.now()
		logInteraction("sidecar", "sendLatency.error", {
			...this.createSendLatencyPayload(trace),
			error: stringify(error),
		})
	}

	private rebindSendLatencyTrace(previousSessionId: string, nextSessionId: string) {
		const trace = this.sendLatencyTraces.get(previousSessionId)
		if (!trace || !nextSessionId || previousSessionId === nextSessionId) {
			return
		}
		this.sendLatencyTraces.delete(previousSessionId)
		trace.sessionId = nextSessionId
		this.sendLatencyTraces.set(nextSessionId, trace)
	}

	private createSendLatencyPayload(trace: SendLatencyTrace) {
		const now = Date.now()
		return {
			requestId: trace.requestId,
			kind: trace.kind,
			sessionId: trace.sessionId,
			textLength: trace.textLength,
			toSdkSendMs: trace.sdkSendAt ? trace.sdkSendAt - trace.startedAt : undefined,
			toFirstSdkEventMs: trace.firstSdkEventAt ? trace.firstSdkEventAt - trace.startedAt : undefined,
			toFirstAssistantMs: trace.firstAssistantAt ? trace.firstAssistantAt - trace.startedAt : undefined,
			toErrorMs: trace.errorAt ? trace.errorAt - trace.startedAt : undefined,
			elapsedMs: now - trace.startedAt,
		}
	}

	private getCurrentSessionId() {
		return this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
	}

	private finalizeOpenPartialMessages() {
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.stopTerminalStatePolling()
		let changed = false
		this.state.clineMessages = this.state.clineMessages.filter((message) => {
			if (message.partial !== true) {
				return true
			}

			if (message.say === "api_req_started" && isPlaceholderApiRequest(getString(message, "text"))) {
				changed = true
				return false
			}

			message.partial = false
			if (message.say === "api_req_started" || message.say === "reasoning") {
				message.isCollapsed = true
				message.isExpanded = false
			}
			this.sendPartialMessage(message)
			changed = true
			return true
		})
		if (changed) {
			logInteraction("sidecar", "finalizedOpenPartials", {})
		}
		this.activePartialTextTs = null
		this.activeReasoningTextTs = null
		this.activeFoldedReasoningText = ""
		this.activeFoldedActivityText = ""
		this.activeTerminalActivityText = ""
		this.activeToolActivityTs = null
		this.activeToolActivityEntries = []
	}

	private schedulePartialIdleWatchdog() {
		this.clearPartialIdleWatchdog()
		const timeoutMs = readPositiveIntEnv("VSCLINE_PARTIAL_IDLE_COMPLETE_MS", 45000)
		this.partialIdleTimer = setTimeout(() => {
			const message = this.state.clineMessages.find((item) => item.ts === this.activePartialTextTs)
			const text = getString(message, "text")
			if (!this.activePartialTextTs || !text.trim()) {
				return
			}

			logInteraction("sidecar", "partialIdleNotice", { timeoutMs, textLength: text.length })
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
		}, timeoutMs)
	}

	private clearPartialIdleWatchdog() {
		if (this.partialIdleTimer) {
			clearTimeout(this.partialIdleTimer)
			this.partialIdleTimer = null
		}
	}

	private clearPartialStateBroadcastTimer() {
		if (this.partialStateBroadcastTimer) {
			clearTimeout(this.partialStateBroadcastTimer)
			this.partialStateBroadcastTimer = null
		}
	}

	private broadcastPartialStateNow() {
		if (this.stateStreamRequestIds.size === 0) {
			return
		}
		this.clearPartialStateBroadcastTimer()
		this.lastPartialStateBroadcastAt = Date.now()
		this.broadcastState().catch((error) => console.error(error))
	}

	private schedulePartialStateBroadcast() {
		if (this.stateStreamRequestIds.size === 0 || this.partialStateBroadcastTimer) {
			return
		}

		const intervalMs = readPositiveIntEnv("VSCLINE_PARTIAL_STATE_BROADCAST_MS", 5000)
		const now = Date.now()
		const elapsed = now - this.lastPartialStateBroadcastAt
		if (elapsed >= intervalMs) {
			this.lastPartialStateBroadcastAt = now
			this.broadcastState().catch((error) => console.error(error))
			return
		}

		this.partialStateBroadcastTimer = setTimeout(() => {
			this.partialStateBroadcastTimer = null
			this.lastPartialStateBroadcastAt = Date.now()
			this.broadcastState().catch((error) => console.error(error))
		}, intervalMs - elapsed)
	}

	private noteTaskActivity(reason: string) {
		if (!this.state.currentTaskItem) {
			return
		}
		this.lastTaskActivityAt = Date.now()
		this.lastTaskActivityReason = reason
		logInteraction("sidecar", "taskActivity", { reason })
		if (this.hasCompletionResultAfterLastUserMessage() || isTerminalSdkStatus(reason) || reason === "done" || reason === "ended" || reason === "run-finished") {
			this.clearTaskIdleWatchdog()
			this.clearPartialIdleWatchdog()
			this.clearPartialStateBroadcastTimer()
			return
		}
		this.scheduleTaskIdleWatchdog()
	}

	private noteQuietTaskActivity(reason: string) {
		if (!this.state.currentTaskItem) {
			return
		}
		this.lastTaskActivityAt = Date.now()
		this.lastTaskActivityReason = reason
	}

	private scheduleTaskIdleWatchdog() {
		this.clearTaskIdleWatchdog()
		if (!this.state.currentTaskItem) {
			return
		}
		const noticeMs = readPositiveIntEnv("VSCLINE_TASK_IDLE_NOTICE_MS", 30000)
		const timeoutMs = readPositiveIntEnv("VSCLINE_TASK_IDLE_COMPLETE_MS", 600_000)
		if (noticeMs > 0 && noticeMs < timeoutMs) {
			this.taskIdleNoticeTimer = setTimeout(() => {
				if (!this.state.currentTaskItem || this.activePartialTextTs) {
					return
				}
				const idleForMs = Date.now() - this.lastTaskActivityAt
				if (idleForMs < noticeMs - 1000) {
					return
				}

				const text = `LIG VS SDK 응답을 기다리는 중입니다. 마지막 활동 후 ${Math.round(idleForMs / 1000)}초가 지났습니다. 마지막 활동: ${this.describeTaskActivityReason(this.lastTaskActivityReason)}`
				logInteraction("sidecar", "taskIdleNotice", { noticeMs, idleForMs, reason: this.lastTaskActivityReason })
			}, noticeMs)
		}
		this.taskIdleTimer = setTimeout(() => {
			if (!this.state.currentTaskItem) {
				return
			}
			const idleForMs = Date.now() - this.lastTaskActivityAt
			if (idleForMs < timeoutMs - 1000) {
				this.scheduleTaskIdleWatchdog()
				return
			}

			logInteraction("sidecar", "taskIdleLongRunning", { timeoutMs, idleForMs, reason: this.lastTaskActivityReason })
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
		}, timeoutMs)
	}

	private clearTaskIdleWatchdog() {
		if (this.taskIdleNoticeTimer) {
			clearTimeout(this.taskIdleNoticeTimer)
			this.taskIdleNoticeTimer = null
		}
		if (this.taskIdleTimer) {
			clearTimeout(this.taskIdleTimer)
			this.taskIdleTimer = null
		}
	}

	private describeTaskActivityReason(reason: string) {
		switch (reason) {
			case "content_start:text":
				return "모델 본문 수신"
			case "content_end:text":
				return "모델 본문 완료"
			case "content_start:tool":
				return "도구 호출 시작"
			case "content_start:reasoning":
				return "모델 reasoning 수신"
			case "content_end:tool":
				return "도구 호출 완료"
			case "content_end:reasoning":
				return "모델 reasoning 완료"
			case "assistant-message":
				return "모델 응답"
			case "tool-finished":
				return "도구 실행 완료"
			case "run-finished":
			case "done":
				return "SDK 작업 완료"
			case "run-failed":
			case "error":
				return "SDK 오류"
			case "usage":
				return "토큰 사용량 갱신"
			default:
				return reason || "알 수 없음"
		}
	}

	private shouldIgnoreSdkEvent(sessionId: string) {
		if (!sessionId) {
			return false
		}
		if (this.closingSessionIds.has(sessionId)) {
			return true
		}
		if (!this.state.currentTaskItem) {
			return true
		}
		const activeSessionId = this.clineSdk?.status.activeSessionId
		if (activeSessionId) {
			return sessionId !== activeSessionId
		}
		const currentTaskId = String(this.state.currentTaskItem?.id || "")
		return !!currentTaskId && sessionId !== currentTaskId
	}

	private bindCurrentTaskToSession(sessionId: string) {
		if (!sessionId || !this.state.currentTaskItem) {
			return
		}
		const currentTaskId = String(this.state.currentTaskItem.id || "")
		if (!currentTaskId || currentTaskId === sessionId) {
			return
		}

		const snapshot = this.getTaskSnapshot(currentTaskId)
		if (snapshot) {
			this.forgetTaskSnapshot(currentTaskId)
			this.rememberTaskSnapshot(sessionId, snapshot.taskItem, snapshot.messages)
		}
		this.state.currentTaskItem = { ...this.state.currentTaskItem, id: sessionId }
		this.state.taskHistory = this.state.taskHistory.map((item) =>
			String(item.id || "") === currentTaskId ? { ...item, id: sessionId } : item,
		)
		this.rebindSendLatencyTrace(currentTaskId, sessionId)
		logInteraction("sidecar", "taskSessionIdRebound", { previousTaskId: currentTaskId, sessionId })
	}

	private upsertMessage(ts: number, updates: Record<string, unknown>) {
		const index = this.state.clineMessages.findIndex((message) => message.ts === ts)
		if (index >= 0) {
			const normalized = normalizeClineMessagePayload({ ...this.state.clineMessages[index], ...updates, ts })
			if (isMeaninglessPlaceholderMessage(normalized) || isMeaninglessToolMessage(normalized) || isMeaninglessTextMessage(normalized)) {
				this.state.clineMessages.splice(index, 1)
			} else {
				this.state.clineMessages[index] = normalized
			}
			this.schedulePersistedStateSave()
		}
	}

	private updateCurrentTaskItem(updates?: Record<string, unknown>) {
		if (!this.state.currentTaskItem) {
			return
		}

		this.state.currentTaskItem = {
			...this.state.currentTaskItem,
			...updates,
			ts: Date.now(),
			size: this.state.clineMessages.length,
		}
		this.state.taskHistory = [
			this.state.currentTaskItem,
			...this.state.taskHistory.filter((item) => item.id !== this.state.currentTaskItem?.id),
		]
		this.rememberTaskSnapshot(String(this.state.currentTaskItem.id || ""), this.state.currentTaskItem, this.state.clineMessages)
		this.schedulePersistedStateSave()
	}

	private getTaskSnapshot(taskId: string) {
		const snapshot = this.taskSnapshots.get(taskId) || cloneTaskSnapshot(asRecord(this.state.taskSnapshots)[taskId])
		if (snapshot) {
			this.taskSnapshots.set(taskId, snapshot)
		}
		return snapshot
	}

	private rememberTaskSnapshot(taskId: string, taskItem: Record<string, unknown>, messages: Array<Record<string, unknown>>) {
		if (!taskId) {
			return
		}
		const snapshot = {
			taskItem: { ...taskItem },
			messages: messages.map((message) => ({ ...message })),
		}
		this.taskSnapshots.set(taskId, snapshot)
		this.state.taskSnapshots = {
			...this.state.taskSnapshots,
			[taskId]: snapshot,
		}
	}

	private forgetTaskSnapshot(taskId: string) {
		this.taskSnapshots.delete(taskId)
		const next = { ...this.state.taskSnapshots }
		delete next[taskId]
		this.state.taskSnapshots = next
	}

	private clearTaskSnapshots() {
		this.taskSnapshots.clear()
		this.state.taskSnapshots = {}
	}

	private getModelId() {
		const apiConfig = asRecord(this.state.apiConfiguration)
		const modePrefix = this.state.mode === "plan" ? "planMode" : "actMode"
		const providerId = normalizeProviderId(getString(apiConfig, `${modePrefix}ApiProvider`) || "anthropic")
		if (providerId === "ollama") {
			return resolveModelId(apiConfig, providerId, modePrefix) || process.env.OLLAMA_MODEL || process.env.CLINE_MODEL_ID || "ollama"
		}

		return resolveModelId(apiConfig, providerId, modePrefix) || process.env.CLINE_MODEL_ID || "claude-sonnet-4-6"
	}

	private createCurrentModelCatalog() {
		const id = this.getModelId()
		return createModelCatalog([id], {
			providerId: normalizeProviderId(getString(asRecord(this.state.apiConfiguration), `${this.state.mode === "plan" ? "planMode" : "actMode"}ApiProvider`)),
			selectedId: id,
			reduced: true,
			message: "Using the configured model because this provider catalog cannot be refreshed locally.",
		})
	}

	private schedulePersistedStateSave() {
		if (this.persistedStateSaveTimer) {
			return
		}

		this.persistedStateSaveTimer = setTimeout(() => {
			this.persistedStateSaveTimer = null
			savePersistedState(this.state)
		}, readPositiveIntEnv("VSCLINE_STATE_SAVE_DEBOUNCE_MS", 250))
		this.persistedStateSaveTimer.unref?.()
	}

	private flushPersistedStateSave() {
		if (this.persistedStateSaveTimer) {
			clearTimeout(this.persistedStateSaveTimer)
			this.persistedStateSaveTimer = null
		}
		savePersistedState(this.state)
	}

	private async createProviderModelCatalog(providerId: string, request: Record<string, unknown>) {
		const normalizedProviderId = normalizeProviderId(providerId)
		const requestConfig = extractApiConfigurationUpdate(request)
		const apiConfig = {
			...asRecord(this.state.apiConfiguration),
			...compactApiConfiguration(requestConfig),
		}
		const modePrefix = this.state.mode === "plan" ? "planMode" : "actMode"
		const selectedId = resolveModelId(apiConfig, normalizedProviderId, modePrefix) || this.getModelId()
		const oauthCredentials = resolveOAuthCredentials(apiConfig, normalizedProviderId)
		const oauthState = describeOAuthCredentialState(oauthCredentials)
		const apiKey = resolveApiKey(apiConfig, normalizedProviderId) || getString(oauthCredentials, "accessToken") || getString(oauthCredentials, "access_token")
		const requestBaseUrl =
			getString(request, "baseUrl") ||
			getString(request, "baseURL") ||
			getString(request, "url") ||
			getString(request, "value")
		const configuredBaseUrl = requestBaseUrl || resolveBaseUrl(apiConfig, normalizedProviderId)
		const baseUrl =
			normalizedProviderId === "lmstudio" && !configuredBaseUrl
				? "http://localhost:1234/v1"
				: configuredBaseUrl || defaultOpenAiCompatibleCatalogBaseUrl(normalizedProviderId, apiKey)

		if (normalizedProviderId === "ollama") {
			const ids = await getOllamaModels(baseUrl)
			if (ids.length > 0) {
				this.applyDefaultOllamaModel(ids[0])
			}
			return createModelCatalog(ids, {
				providerId: normalizedProviderId,
				selectedId: selectedId || ids[0],
				source: "ollama:/api/tags",
				supported: true,
				reduced: ids.length === 0,
				message: ids.length > 0 ? "" : "Ollama did not return any local models. Check that Ollama is running and has pulled models.",
				diagnostics: createCatalogDiagnostics(normalizedProviderId, "ollama:/api/tags", {
					baseUrl: normalizeOllamaRootBaseUrl(baseUrl),
					authenticated: false,
					modelCount: ids.length,
				}),
			})
		}

		if (isOpenAiCompatibleCatalogProvider(normalizedProviderId)) {
			if (!baseUrl) {
				return createModelCatalog(selectedId ? [selectedId] : [], {
					providerId: normalizedProviderId,
					selectedId,
					supported: true,
					reduced: true,
					message: `${providerAuthLabel(normalizedProviderId)} does not expose a configured model catalog endpoint in this Visual Studio port, so the configured model is shown as a reduced catalog.`,
					diagnostics: createCatalogDiagnostics(normalizedProviderId, "reduced", {
						baseUrlConfigured: false,
						authenticated: Boolean(apiKey),
						oauthRefreshStatus: oauthState.refreshStatus,
					}),
				})
			}

			const result = await getOpenAiCompatibleModels(baseUrl, apiKey)
			return createModelCatalog(result.ids, {
				providerId: normalizedProviderId,
				selectedId: selectedId || result.ids[0],
				source: `${normalizeOpenAiCompatibleBaseUrl(baseUrl)}/models`,
				supported: true,
				reduced: result.ids.length === 0,
				message: result.error || (result.ids.length > 0 ? "" : "The model endpoint returned no models."),
				error: result.error,
				modelInfoById: result.modelInfoById,
				diagnostics: createCatalogDiagnostics(normalizedProviderId, "openai-compatible:/models", {
					baseUrl: normalizeOpenAiCompatibleBaseUrl(baseUrl),
					authenticated: Boolean(apiKey),
					oauthRefreshStatus: oauthState.refreshStatus,
					modelCount: result.ids.length,
					error: result.error,
				}),
			})
		}

		return this.createUnsupportedModelCatalog(`ModelsService.refresh:${normalizedProviderId}`)
	}

	private createUnsupportedModelCatalog(key: string) {
		const providerId = key.replace(/^ModelsService\./, "").replace(/Rpc$/, "")
		return createModelCatalog([], {
			providerId,
			supported: false,
			reduced: true,
			message: `${key} is not implemented in the air-gap Visual Studio port. Configure a local Ollama, LM Studio, LiteLLM, or OpenAI-compatible endpoint instead.`,
			diagnostics: createCatalogDiagnostics(providerId, "unsupported", {
				authenticated: false,
				reason: "air_gap_provider_catalog_not_implemented",
			}),
		})
	}

	private async broadcastState() {
		const messages = this.buildStateMessages()
		if (messages.length === 0) {
			return
		}

		logInteraction("sidecar->webview", "state.broadcast", { count: messages.length, messages: messages.map(summarizeGrpcMessageForLog) })
		await Promise.all(
			messages.map((message) =>
				sendHostRequest(
					this.connection,
					"webview.postMessage",
					{ message },
				),
			),
		)
	}

	private buildStateMessages() {
		const stateJson = JSON.stringify(this.state)
		const stateKey = String(stateJson.length) + ":" + fastStringHash(stateJson)
		return [...this.stateStreamRequestIds]
			.map((requestId) => {
				const deliveryKey = `${requestId}:${stateKey}`
				if (this.lastStateBroadcastKeys.get(requestId) === deliveryKey) {
					return null
				}
				this.lastStateBroadcastKeys.set(requestId, deliveryKey)
				return grpcResponse(requestId, { stateJson }, true)
			})
			.filter((message): message is ReturnType<typeof grpcResponse> => message !== null)
	}

	private sendPartialMessage(message: Record<string, unknown> | undefined) {
		if (!message || this.partialMessageStreamRequestIds.size === 0) {
			return
		}

		const messageKey = partialMessageDeliveryKey(message)
		for (const requestId of this.partialMessageStreamRequestIds) {
			const deliveryKey = `${requestId}:${messageKey}`
			if (this.lastPartialMessageKeys.get(requestId) === deliveryKey) {
				continue
			}
			this.lastPartialMessageKeys.set(requestId, deliveryKey)
			logInteraction("sidecar->webview", "partialMessage", { requestId, message: summarizeClineMessageForLog(message) })
			sendHostRequest(
				this.connection,
				"webview.postMessage",
				{ message: grpcResponse(requestId, toProtoClineMessage(message), true) },
			).catch((error) => console.error(error))
		}
	}

	private refreshStateStreamsInBackground() {
		if (this.stateHydrationRefreshInFlight) {
			return
		}
		this.stateHydrationRefreshInFlight = true
		void (async () => {
			try {
				await this.refreshTaskHistoryFromSdk()
				await this.refreshSelectedTaskFromSdk()
				await this.broadcastState()
			} catch (error) {
				logInteraction("sidecar", "stateHydrationRefreshFailed", { error: stringify(error) })
			} finally {
				this.stateHydrationRefreshInFlight = false
			}
		})()
	}

	private scheduleStateStreamsRefresh() {
		const delayMs = readPositiveIntEnv("VSCLINE_STATE_REFRESH_DELAY_MS", 2500)
		setTimeout(() => {
			if (this.state.currentTaskItem && this.clineSdk?.status.activeSessionId) {
				return
			}
			this.refreshStateStreamsInBackground()
		}, delayMs).unref?.()
	}
}

function shouldLogSdkEventForInteraction(event: unknown) {
	const record = asRecord(event)
	const type = getString(record, "type")
	if (type !== "chunk") {
		return true
	}

	const payload = asRecord(record.payload)
	if (getString(payload, "stream") !== "agent") {
		return true
	}

	const chunkRecord = sdkChunkRecord(payload.chunk)
	const chunkType = getString(chunkRecord, "type")
	const contentType = getString(chunkRecord, "contentType")
	return !(
		(chunkType === "content_start" || chunkType === "content_update" || chunkType === "content_delta") &&
		(contentType === "reasoning" || contentType === "text")
	)
}

function sdkChunkRecord(chunk: unknown) {
	if (typeof chunk === "string") {
		return asRecord(tryParseJson(chunk) ?? {})
	}
	return asRecord(chunk)
}

function summarizeSdkEventForLog(event: unknown) {
	const record = asRecord(event)
	const type = getString(record, "type")
	const payload = asRecord(record.payload)
	if (type === "agent_event") {
		return {
			type,
			sessionId: getString(payload, "sessionId"),
			event: summarizeAgentChunkForLog(payload.event),
		}
	}
	if (type === "chunk") {
		return {
			type,
			sessionId: getString(payload, "sessionId"),
			stream: getString(payload, "stream"),
			chunk: summarizeAgentChunkForLog(payload.chunk),
		}
	}
	if (type === "session_snapshot") {
		const snapshot = asRecord(payload.snapshot)
		return {
			type,
			sessionId: getString(payload, "sessionId"),
			status: getString(snapshot, "status"),
			messageCount: getNumber(snapshot, "messageCount"),
		}
	}
	return event
}

function summarizeAgentChunkForLog(value: unknown) {
	if (typeof value === "string") {
		return { kind: "string", length: value.length, preview: truncateText(value, 240) }
	}
	const record = asRecord(value)
	if (Object.keys(record).length === 0) {
		return { kind: typeof value }
	}
	return {
		type: getString(record, "type"),
		contentType: getString(record, "contentType"),
		toolName: getString(record, "toolName"),
		textLength: getString(record, "text").length,
		accumulatedLength: getString(record, "accumulated").length,
		reasoningLength: getString(record, "reasoning").length,
		hasInput: Object.keys(asRecord(record.input)).length > 0,
		hasOutput: record.output !== undefined,
		hasUsage: record.usage !== undefined,
	}
}

function summarizeClineMessageForLog(message: Record<string, unknown>) {
	const text = getString(message, "text")
	return {
		ts: getNumber(message, "ts"),
		type: getString(message, "type"),
		say: getString(message, "say"),
		ask: getString(message, "ask"),
		partial: message.partial === true,
		textLength: text.length,
		textPreview: truncateText(text, 240),
	}
}

function summarizeGrpcMessageForLog(message: unknown) {
	const record = asRecord(message)
	const grpcResponseRecord = asRecord(record.grpc_response)
	const responseMessage = asRecord(grpcResponseRecord.message)
	const stateJson = getString(responseMessage, "stateJson")
	return {
		type: getString(record, "type"),
		requestId: getString(grpcResponseRecord, "request_id"),
		isStreaming: grpcResponseRecord.is_streaming === true,
		error: truncateText(getString(grpcResponseRecord, "error"), 240),
		stateJsonLength: stateJson.length,
	}
}

function fastStringHash(value: string) {
	let hash = 2166136261
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(16)
}

function readRequestId(message: unknown) {
	const record = asRecord(message)
	return getString(record, "request_id") || getString(record, "requestId")
}

function getString(message: unknown, key: string): string {
	if (typeof message !== "object" || message === null || !(key in message)) {
		return ""
	}

	const value = (message as Record<string, unknown>)[key]
	return typeof value === "string" ? value : ""
}

function getStringArray(message: unknown, key: string): string[] {
	const record = asRecord(message)
	const value = record[key]
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function getBoolean(message: unknown, key: string): boolean | undefined {
	const record = asRecord(message)
	const value = record[key]
	return typeof value === "boolean" ? value : undefined
}

function normalizePromptDelivery(value: string): "queue" | "steer" | undefined {
	return value === "queue" || value === "steer" ? value : undefined
}

function getNumber(message: unknown, key: string): number | undefined {
	const record = asRecord(message)
	const value = record[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function truncateForStatus(value: string, maxLength: number) {
	const normalized = value.replace(/\s+/g, " ").trim()
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function parseGitWorktreePorcelain(output: string) {
	const worktrees: Array<Record<string, unknown>> = []
	let current: Record<string, unknown> | null = null

	const pushCurrent = () => {
		if (current && getString(current, "path")) {
			worktrees.push(current)
		}
		current = null
	}

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line) {
			pushCurrent()
			continue
		}

		const [key, ...rest] = line.split(" ")
		const value = rest.join(" ")
		if (key === "worktree") {
			pushCurrent()
			current = {
				path: value,
				branch: "",
				head: "",
				isBare: false,
				isDetached: false,
				isLocked: false,
				isPrunable: false,
				isCurrent: false,
			}
			continue
		}

		if (!current) {
			continue
		}

		switch (key) {
			case "HEAD":
				current.head = value
				break
			case "branch":
				current.branch = value.replace(/^refs\/heads\//, "")
				break
			case "bare":
				current.isBare = true
				break
			case "detached":
				current.isDetached = true
				break
			case "locked":
				current.isLocked = true
				current.lockReason = value
				break
			case "prunable":
				current.isPrunable = true
				current.prunableReason = value
				break
		}
	}
	pushCurrent()
	return worktrees
}

function uniqueSortedLines(output: string) {
	return Array.from(
		new Set(
			output
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean),
		),
	).sort((left, right) => left.localeCompare(right))
}

function classifyWorktreeGitError(stderr: string, operation: "create" | "delete" | "merge") {
	const text = (stderr || "").trim()
	const lower = text.toLowerCase()
	if (!text) {
		return operation === "create"
			? "Failed to create worktree."
			: operation === "delete"
				? "Failed to delete worktree."
				: "Failed to merge worktree."
	}
	if (lower.includes("already exists")) {
		return `Target path or branch already exists. ${text}`
	}
	if (lower.includes("invalid reference") || lower.includes("not a valid branch") || lower.includes("not a valid object name")) {
		return `The selected branch or base branch is invalid. ${text}`
	}
	if (lower.includes("is already checked out")) {
		return `The selected branch is already checked out in another worktree. ${text}`
	}
	if (lower.includes("not a git repository")) {
		return `This folder is not a git repository. ${text}`
	}
	if (lower.includes("permission denied") || lower.includes("access is denied")) {
		return `Git could not access the target path. ${text}`
	}
	if (lower.includes("uncommitted changes") || lower.includes("local changes")) {
		return `Uncommitted changes are blocking this worktree operation. ${text}`
	}
	if (lower.includes("conflict") || lower.includes("automatic merge failed")) {
		return `Merge conflict detected. ${text}`
	}
	return text
}

function normalizeMergeRecoveryAction(value: string) {
	const normalized = value.trim().toLowerCase()
	return normalized === "abort" || normalized === "continue" || normalized === "status" ? normalized : "status"
}

function samePath(left: string, right: string) {
	if (!left || !right) {
		return false
	}
	return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function isPathInside(candidate: string, root: string) {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function findSolutions(root: string) {
	const solutions = new Set<string>()
	const direct = safeReadDir(root)
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sln"))
		.map((entry) => path.join(root, entry.name))
		.sort()
	for (const solution of direct) {
		solutions.add(solution)
	}

	const queue = safeReadDir(root)
		.filter((entry) => entry.isDirectory() && ![".git", "bin", "obj", "node_modules"].includes(entry.name))
		.map((entry) => path.join(root, entry.name))
	while (queue.length > 0) {
		const current = queue.shift()!
		const entries = safeReadDir(current)
		for (const solution of entries
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sln"))
			.map((entry) => path.join(current, entry.name))
			.sort()) {
			solutions.add(solution)
		}
		for (const entry of entries) {
			if (entry.isDirectory() && ![".git", "bin", "obj", "node_modules"].includes(entry.name)) {
				queue.push(path.join(current, entry.name))
			}
		}
	}
	return Array.from(solutions).sort()
}

function safeReadDir(root: string) {
	try {
		return fs.readdirSync(root, { withFileTypes: true })
	} catch {
		return []
	}
}

function resolveBrowserExecutablePath(configuredPath = "") {
	const candidates = [
		configuredPath,
		process.env.CHROME_PATH || "",
		process.env.EDGE_PATH || "",
		process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
		process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"] as string, "Google", "Chrome", "Application", "chrome.exe") : "",
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
		process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe") : "",
		process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"] as string, "Microsoft", "Edge", "Application", "msedge.exe") : "",
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : "",
	]

	return candidates.find((candidate) => candidate.trim() && fs.existsSync(candidate)) || ""
}

function normalizeBrowserDebugHost(host: string) {
	const trimmed = host.trim()
	if (!trimmed) {
		return ""
	}

	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
	return withProtocol.replace(/\/+$/, "")
}

async function canReachBrowserDebugHost(host: string) {
	return (await fetchBrowserDebugInfo(host)).success === true
}

async function fetchBrowserDebugInfo(host: string) {
	const normalized = normalizeBrowserDebugHost(host)
	if (!normalized) {
		return { success: false, error: "Browser debug host is not configured." }
	}

	const timeoutMs = readPositiveIntEnv("VSCLINE_BROWSER_CONNECT_TIMEOUT_MS", 2000)
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const versionResponse = await fetch(`${normalized}/json/version`, { signal: controller.signal })
		if (!versionResponse.ok) {
			return { success: false, host: normalized, error: `Browser debug host returned HTTP ${versionResponse.status}.` }
		}

		const version = asRecord(await versionResponse.json().catch(() => ({})))
		const tabsResponse = await fetch(`${normalized}/json/list`, { signal: controller.signal }).catch(() => null)
		const tabs = tabsResponse?.ok ? await tabsResponse.json().catch(() => []) : []
		const tabRecords = Array.isArray(tabs) ? tabs.map(asRecord) : []
		const pageTabs = tabRecords.filter((tab) => getString(tab, "type") === "page")
		const activeTab = pageTabs[0] || tabRecords[0] || {}
		return {
			success: true,
			host: normalized,
			browser: getString(version, "Browser"),
			protocolVersion: getString(version, "Protocol-Version"),
			tabCount: pageTabs.length || tabRecords.length,
			activeTabTitle: getString(activeTab, "title"),
			activeTabUrl: getString(activeTab, "url"),
		}
	} catch (error) {
		const message = error instanceof Error && error.name === "AbortError"
			? `Browser debug connection timed out after ${Math.round(timeoutMs / 1000)} seconds.`
			: stringify(error)
		return { success: false, host: normalized, error: message }
	} finally {
		clearTimeout(timer)
	}
}

type BrowserViewport = { width: number; height: number }
type DevToolsTab = {
	id: string
	type: string
	url: string
	title: string
	webSocketDebuggerUrl: string
}
type BrowserAdapterAction = {
	action: string
	url?: string
	tabId?: string
	browserSessionId?: string
	browserActionId?: string
	coordinate?: string
	text?: string
	viewport: BrowserViewport
	onPhase?: (phase: Record<string, unknown>) => void
}

function normalizeBrowserViewport(value: unknown): BrowserViewport {
	const record = asRecord(value)
	return {
		width: Math.max(320, Math.min(numberValue(record.width) || 900, 4096)),
		height: Math.max(240, Math.min(numberValue(record.height) || 600, 4096)),
	}
}

function normalizeBrowserActionName(value: string) {
	const normalized = value.trim().toLowerCase().replace(/[-\s]/g, "_")
	switch (normalized) {
		case "browser_action_launch":
		case "launch_browser":
		case "launch":
			return "launch"
		case "open":
		case "goto":
		case "go_to":
		case "navigate":
			return "navigate"
		case "screenshot":
		case "capture_screenshot":
			return "screenshot"
		case "scroll_down":
		case "scroll_up":
		case "click":
		case "type":
		case "close":
			return normalized
		default:
			return normalized || "navigate"
	}
}

async function listDevToolsTabs(host: string) {
	const normalized = normalizeBrowserDebugHost(host)
	if (!normalized) {
		return { success: false, tabs: [], error: "Browser debug host is not configured." }
	}
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), readPositiveIntEnv("VSCLINE_BROWSER_CONNECT_TIMEOUT_MS", 2000))
	try {
		const response = await fetch(`${normalized}/json/list`, { signal: controller.signal })
		if (!response.ok) {
			return { success: false, host: normalized, tabs: [], error: `Browser tab list returned HTTP ${response.status}.` }
		}
		const tabs = arrayOfRecords(await response.json().catch(() => []))
			.filter((tab) => getString(tab, "type") === "page")
			.map((tab) => ({
				id: getString(tab, "id"),
				type: getString(tab, "type"),
				url: getString(tab, "url"),
				title: getString(tab, "title"),
				webSocketDebuggerUrl: getString(tab, "webSocketDebuggerUrl"),
			}))
			.filter((tab) => tab.id && tab.webSocketDebuggerUrl)
		return { success: true, host: normalized, tabs }
	} catch (error) {
		const message = error instanceof Error && error.name === "AbortError"
			? "Browser tab list timed out."
			: stringify(error)
		return { success: false, host: normalized, tabs: [], error: message }
	} finally {
		clearTimeout(timer)
	}
}

async function runBrowserActionViaDevTools(host: string, request: BrowserAdapterAction) {
	const normalized = normalizeBrowserDebugHost(host)
	if (!normalized) {
		return { success: false, status: "error", error: "Browser debug host is not configured." }
	}
	if (typeof (globalThis as Record<string, unknown>).WebSocket !== "function") {
		return { success: false, status: "unsupported", error: "Node WebSocket runtime is unavailable; bundled Node 22+ is required." }
	}

	try {
		request.onPhase?.({ phase: "resolving_tab", action: normalizeBrowserActionName(request.action), host: normalized })
		let tab = await resolveDevToolsTab(normalized, request)
		let lastError: unknown
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				request.onPhase?.({ phase: attempt > 0 ? "reconnected" : "connected", action: normalizeBrowserActionName(request.action), tabId: tab.id })
				return await executeBrowserActionOnDevToolsTab(normalized, tab, request)
			} catch (error) {
				lastError = error
				if (attempt > 0 || !isRetryableDevToolsError(error)) {
					throw error
				}
				request.onPhase?.({
					phase: "reconnecting",
					action: normalizeBrowserActionName(request.action),
					tabId: tab.id,
					reconnectReason: stringify(error),
				})
				tab = await resolveDevToolsTab(normalized, { ...request, tabId: "" })
			}
		}
		throw lastError
	} catch (error) {
		return {
			success: false,
			status: "error",
			action: normalizeBrowserActionName(request.action),
			browserSessionId: request.browserSessionId || normalized,
			browserActionId: request.browserActionId,
			error: stringify(error),
		}
	}
}

async function executeBrowserActionOnDevToolsTab(host: string, tab: DevToolsTab, request: BrowserAdapterAction) {
	const client = await connectDevTools(tab.webSocketDebuggerUrl)
	try {
		request.onPhase?.({ phase: "preparing", action: normalizeBrowserActionName(request.action), tabId: tab.id })
		await client.send("Page.enable")
		await client.send("Runtime.enable")
		await client.send("Emulation.setDeviceMetricsOverride", {
			width: request.viewport.width,
			height: request.viewport.height,
			deviceScaleFactor: 1,
			mobile: false,
		})

		const action = normalizeBrowserActionName(request.action)
		if ((action === "launch" || action === "navigate") && request.url) {
			request.onPhase?.({ phase: "navigating", action, tabId: tab.id, url: request.url })
			const loaded = client.waitForEvent("Page.loadEventFired", readPositiveIntEnv("VSCLINE_BROWSER_NAVIGATION_TIMEOUT_MS", 10000))
			await client.send("Page.navigate", { url: normalizeBrowserNavigationUrl(request.url) })
			await loaded.catch(() => waitForDevToolsSettle())
		} else if (action === "click") {
			request.onPhase?.({ phase: "clicking", action, tabId: tab.id, coordinate: request.coordinate })
			const coordinate = parseBrowserCoordinate(request.coordinate, request.viewport)
			await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: coordinate.x, y: coordinate.y, button: "left", clickCount: 1 })
			await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: coordinate.x, y: coordinate.y, button: "left", clickCount: 1 })
			await waitForDevToolsSettle(250)
		} else if (action === "type") {
			request.onPhase?.({ phase: "typing", action, tabId: tab.id })
			await client.send("Input.insertText", { text: request.text || "" })
			await waitForDevToolsSettle(150)
		} else if (action === "scroll_down" || action === "scroll_up") {
			request.onPhase?.({ phase: "scrolling", action, tabId: tab.id })
			await client.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: Math.round(request.viewport.width / 2),
				y: Math.round(request.viewport.height / 2),
				deltaY: action === "scroll_down" ? request.viewport.height * 0.75 : -request.viewport.height * 0.75,
				deltaX: 0,
			})
			await waitForDevToolsSettle(250)
		} else if (action === "close") {
			request.onPhase?.({ phase: "closing", action, tabId: tab.id })
			await closeDevToolsTab(host, tab.id)
			return {
				success: true,
				status: "closed",
				action,
				browserSessionId: request.browserSessionId || host,
				browserActionId: request.browserActionId,
				tabId: tab.id,
				url: tab.url,
				title: tab.title,
				currentUrl: tab.url,
			}
		}

		request.onPhase?.({ phase: "capturing", action, tabId: tab.id })
		const state = await readDevToolsPageState(client)
		const screenshot = await captureDevToolsScreenshot(client)
		return {
			success: true,
			status: "ok",
			action,
			browserSessionId: request.browserSessionId || host,
			browserActionId: request.browserActionId,
			tabId: tab.id,
			url: state.url || tab.url,
			title: state.title || tab.title,
			currentUrl: state.url || tab.url,
			screenshot,
		}
	} finally {
		client.close()
	}
}

async function resolveDevToolsTab(host: string, request: BrowserAdapterAction): Promise<DevToolsTab> {
	const action = normalizeBrowserActionName(request.action)
	if ((action === "launch" || action === "navigate") && request.url && !request.tabId) {
		const created = await createDevToolsTab(host, request.url).catch(() => undefined)
		if (created?.webSocketDebuggerUrl) {
			return created
		}
	}

	const list = await listDevToolsTabs(host)
	const tabs = Array.isArray(list.tabs) ? list.tabs as DevToolsTab[] : []
	const tab = tabs.find((candidate) => candidate.id === request.tabId) || tabs[0]
	if (!tab) {
		throw new Error("No Chrome DevTools page tab is available. Open Chrome or Edge with --remote-debugging-port=9222.")
	}
	return tab
}

async function createDevToolsTab(host: string, url: string): Promise<DevToolsTab | undefined> {
	const target = `${host}/json/new?${encodeURIComponent(normalizeBrowserNavigationUrl(url))}`
	const response = await fetch(target, { method: "PUT" }).catch(() => fetch(target))
	if (!response.ok) {
		return undefined
	}
	const tab = asRecord(await response.json().catch(() => ({})))
	const webSocketDebuggerUrl = getString(tab, "webSocketDebuggerUrl")
	if (!webSocketDebuggerUrl) {
		return undefined
	}
	return {
		id: getString(tab, "id"),
		type: getString(tab, "type"),
		url: getString(tab, "url"),
		title: getString(tab, "title"),
		webSocketDebuggerUrl,
	}
}

async function closeDevToolsTab(host: string, tabId: string) {
	if (!tabId) {
		return
	}
	await fetch(`${host}/json/close/${encodeURIComponent(tabId)}`).catch(() => undefined)
}

function connectDevTools(webSocketDebuggerUrl: string) {
	const WebSocketCtor = (globalThis as Record<string, any>).WebSocket
	const socket = new WebSocketCtor(webSocketDebuggerUrl)
	let nextId = 1
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	const eventWaiters = new Map<string, Array<{ resolve: (value: unknown) => void; timer: NodeJS.Timeout }>>()
	const opened = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out opening Chrome DevTools WebSocket.")), readPositiveIntEnv("VSCLINE_BROWSER_CONNECT_TIMEOUT_MS", 2000))
		socket.addEventListener("open", () => {
			clearTimeout(timeout)
			resolve()
		})
		socket.addEventListener("error", () => {
			clearTimeout(timeout)
			reject(new Error("Chrome DevTools WebSocket connection failed."))
		})
	})

	socket.addEventListener("message", (event: { data: unknown }) => {
		const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8")
		const message = asRecord(tryParseJson(data) || {})
		const id = numberValue(message.id)
		const method = getString(message, "method")
		if (method && eventWaiters.has(method)) {
			const waiters = eventWaiters.get(method) || []
			eventWaiters.delete(method)
			for (const waiter of waiters) {
				clearTimeout(waiter.timer)
				waiter.resolve(message.params ?? message)
			}
		}
		if (!id || !pending.has(id)) {
			return
		}
		const waiter = pending.get(id)!
		pending.delete(id)
		const error = asRecord(message.error)
		if (Object.keys(error).length > 0) {
			waiter.reject(new Error(getString(error, "message") || JSON.stringify(error)))
		} else {
			waiter.resolve(message.result)
		}
	})

	socket.addEventListener("close", () => {
		for (const waiter of pending.values()) {
			waiter.reject(new Error("Chrome DevTools WebSocket closed."))
		}
		pending.clear()
		for (const waiters of eventWaiters.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer)
				waiter.resolve(undefined)
			}
		}
		eventWaiters.clear()
	})

	return {
		async send(method: string, params?: Record<string, unknown>) {
			await opened
			const id = nextId++
			const timeoutMs = readPositiveIntEnv("VSCLINE_BROWSER_ACTION_TIMEOUT_MS", 8000)
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id)
					reject(new Error(`Chrome DevTools command timed out: ${method}`))
				}, timeoutMs)
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timer)
						resolve(value)
					},
					reject: (error) => {
						clearTimeout(timer)
						reject(error)
					},
				})
				socket.send(JSON.stringify({ id, method, params: params || {} }))
			})
		},
		async waitForEvent(method: string, timeoutMs: number) {
			await opened
			return new Promise<unknown>((resolve) => {
				const timer = setTimeout(() => {
					const waiters = eventWaiters.get(method) || []
					eventWaiters.set(method, waiters.filter((waiter) => waiter.resolve !== resolve))
					resolve(undefined)
				}, Math.max(1, timeoutMs))
				const waiters = eventWaiters.get(method) || []
				waiters.push({ resolve, timer })
				eventWaiters.set(method, waiters)
			})
		},
		close() {
			try {
				socket.close()
			} catch {
				// ignore close errors
			}
		},
	}
}

async function readDevToolsPageState(client: Awaited<ReturnType<typeof connectDevTools>>) {
	const result = asRecord(await client.send("Runtime.evaluate", {
		expression: "({ url: location.href, title: document.title })",
		returnByValue: true,
	}))
	return asRecord(asRecord(asRecord(result.result).value))
}

async function captureDevToolsScreenshot(client: Awaited<ReturnType<typeof connectDevTools>>) {
	const result = asRecord(await client.send("Page.captureScreenshot", { format: "png", fromSurface: true }))
	const data = getString(result, "data")
	return data ? `data:image/png;base64,${data}` : ""
}

function parseBrowserCoordinate(coordinate: string | undefined, viewport: BrowserViewport) {
	const match = /^(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)$/.exec(coordinate || "")
	return {
		x: match ? Math.max(0, Math.min(Number(match[1]), viewport.width)) : Math.round(viewport.width / 2),
		y: match ? Math.max(0, Math.min(Number(match[2]), viewport.height)) : Math.round(viewport.height / 2),
	}
}

function normalizeBrowserNavigationUrl(value: string) {
	const trimmed = value.trim()
	if (!trimmed) {
		return "about:blank"
	}
	if (/^(https?|file|about):/i.test(trimmed)) {
		return trimmed
	}
	return `https://${trimmed}`
}

function browserActionResultForTranscript(result: Record<string, unknown>) {
	return {
		screenshot: getString(result, "screenshot"),
		screenshotBytes: numberValue(result.screenshotBytes) || screenshotByteLength(getString(result, "screenshot")),
		currentUrl: getString(result, "currentUrl") || getString(result, "url"),
		logs: getString(result, "error") || (result.success === false ? "Browser action failed." : ""),
		currentMousePosition: getString(result, "currentMousePosition"),
		browserSessionId: getString(result, "browserSessionId"),
		tabId: getString(result, "tabId"),
		url: getString(result, "url"),
		title: getString(result, "title"),
		action: getString(result, "action"),
		status: getString(result, "status"),
		error: getString(result, "error"),
	}
}

function screenshotByteLength(value: string) {
	const marker = "base64,"
	const index = value.indexOf(marker)
	if (index < 0) {
		return 0
	}
	const base64 = value.slice(index + marker.length)
	return Math.floor((base64.length * 3) / 4)
}

function isBrowserToolName(toolName: string) {
	const normalized = toolName.trim().toLowerCase()
	return normalized === "browser" ||
		normalized === "browser_action" ||
		normalized === "browseraction" ||
		normalized === "browser_action_launch" ||
		normalized === "browser_action_result"
}

function isRetryableDevToolsError(error: unknown) {
	const text = stringify(error).toLowerCase()
	return text.includes("websocket closed") ||
		text.includes("target closed") ||
		text.includes("no chrome devtools page tab") ||
		text.includes("cannot find context") ||
		text.includes("inspected target")
}

function waitForDevToolsSettle(ms = 500) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkIsImageUrl(url: string) {
	const normalized = normalizeHttpUrl(url)
	if (!normalized || process.env.VSCLINE_ENABLE_WEB_FETCH !== "1") {
		return { value: false, success: false, disabled: process.env.VSCLINE_ENABLE_WEB_FETCH !== "1" }
	}
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), readPositiveIntEnv("VSCLINE_WEB_FETCH_TIMEOUT_MS", 5000))
	try {
		const response = await fetch(normalized, { method: "HEAD", signal: controller.signal })
		const contentType = response.headers.get("content-type") || ""
		return { value: response.ok && contentType.toLowerCase().startsWith("image/"), contentType, success: response.ok }
	} catch (error) {
		return { value: false, success: false, error: stringify(error) }
	} finally {
		clearTimeout(timeout)
	}
}

async function fetchOpenGraphData(url: string) {
	const normalized = normalizeHttpUrl(url)
	if (!normalized) {
		return { success: false, error: "Invalid URL." }
	}
	if (process.env.VSCLINE_ENABLE_WEB_FETCH !== "1") {
		return {
			success: false,
			disabled: true,
			url: normalized,
			message: "Web preview fetching is disabled for air-gap mode. Set VSCLINE_ENABLE_WEB_FETCH=1 to enable it.",
		}
	}

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), readPositiveIntEnv("VSCLINE_WEB_FETCH_TIMEOUT_MS", 8000))
	try {
		const response = await fetch(normalized, {
			signal: controller.signal,
			headers: { Accept: "text/html,*/*;q=0.5", "User-Agent": "LIG-VS/1.0 VisualStudio2022" },
		})
		if (!response.ok) {
			return { success: false, url: normalized, error: `HTTP ${response.status}` }
		}
		const html = await response.text()
		const title = extractHtmlMeta(html, "og:title") || extractHtmlTitle(html)
		const description = extractHtmlMeta(html, "og:description") || extractHtmlMeta(html, "description")
		const image = extractHtmlMeta(html, "og:image")
		return {
			success: true,
			url: normalized,
			title,
			description,
			image,
			siteName: extractHtmlMeta(html, "og:site_name"),
		}
	} catch (error) {
		return { success: false, url: normalized, error: stringify(error) }
	} finally {
		clearTimeout(timeout)
	}
}

function extractHtmlTitle(html: string) {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
	return match ? decodeBasicHtmlEntities(match[1].replace(/\s+/g, " ").trim()) : ""
}

function extractHtmlMeta(html: string, key: string) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const propertyPattern = new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${escaped}["'])(?=[^>]*content=["']([^"']*)["'])[^>]*>`, "i")
	const match = propertyPattern.exec(html)
	return match ? decodeBasicHtmlEntities(match[1].trim()) : ""
}

function decodeBasicHtmlEntities(value: string) {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : []
}

function numberValue(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function firstNumberValue(record: Record<string, unknown>, keys: string[]) {
	for (const key of keys) {
		const value = numberValue(record[key])
		if (value !== undefined) {
			return value
		}
	}
	return undefined
}

function normalizeUsageSnapshot(value: unknown): NormalizedUsage {
	const usage = asRecord(value)
	const normalized: NormalizedUsage = {
		inputTokens: firstNumberValue(usage, ["inputTokens", "tokensIn", "promptTokens", "totalInputTokens"]),
		outputTokens: firstNumberValue(usage, ["outputTokens", "tokensOut", "completionTokens", "totalOutputTokens"]),
		cacheReadTokens: firstNumberValue(usage, ["cacheReadTokens", "cacheReads", "cache_read_tokens", "totalCacheReadTokens"]),
		cacheWriteTokens: firstNumberValue(usage, [
			"cacheWriteTokens",
			"cacheWrites",
			"cache_creation_input_tokens",
			"totalCacheWriteTokens",
		]),
		totalCost: firstNumberValue(usage, ["totalCost", "cost"]),
		reliable: false,
	}
	normalized.reliable =
		(normalized.inputTokens || 0) +
			(normalized.outputTokens || 0) +
			(normalized.cacheReadTokens || 0) +
			(normalized.cacheWriteTokens || 0) >
			0 || (normalized.totalCost || 0) > 0
	return normalized
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined
}

function readPositiveIntEnv(name: string, fallback: number) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function readOptionalPositiveIntEnv(name: string) {
	const raw = process.env[name]
	if (!raw) {
		return undefined
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : undefined
}

function resolveRequestTimeoutMs(apiConfig: Record<string, unknown>) {
	const configured =
		numberValue(apiConfig.requestTimeoutMs) ||
		numberValue(apiConfig.apiTimeoutMs) ||
		numberValue(apiConfig.openAiRequestTimeoutMs) ||
		numberValue(apiConfig.openAiCompatibleRequestTimeoutMs)
	return configured && configured > 0 ? configured : readPositiveIntEnv("VSCLINE_API_TIMEOUT_MS", 600_000)
}

function resolveReasoningEffort(apiConfig: Record<string, unknown>, modePrefix: string) {
	const candidates = [
		getString(apiConfig, `${modePrefix}ReasoningEffort`),
		getString(apiConfig, `${modePrefix}OpenAiReasoningEffort`),
		getString(apiConfig, "reasoningEffort"),
		getString(apiConfig, "openAiReasoningEffort"),
		getString(apiConfig, "openAiCompatibleReasoningEffort"),
	]
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)

	for (const candidate of candidates) {
		if (candidate === "low" || candidate === "medium" || candidate === "high" || candidate === "xhigh" || candidate === "none") {
			return candidate
		}
	}

	return process.env.VSCLINE_REASONING_EFFORT as "low" | "medium" | "high" | "xhigh" | "none" | undefined
}

function resolveThinkingEnabled(
	apiConfig: Record<string, unknown>,
	modePrefix: string,
	providerId: string,
	reasoningEffort?: string,
): boolean | undefined {
	const candidates = [
		booleanValue(apiConfig[`${modePrefix}EnableThinking`]),
		booleanValue(apiConfig[`${modePrefix}ThinkingEnabled`]),
		booleanValue(apiConfig.enableThinking),
		booleanValue(apiConfig.thinking),
		booleanValue(apiConfig.openAiThinkingEnabled),
		booleanValue(apiConfig.openAiCompatibleThinkingEnabled),
	].filter((value): value is boolean => value !== undefined)

	if (candidates.length > 0) {
		return candidates[0]
	}

	if (reasoningEffort === "none") {
		return false
	}
	if (reasoningEffort) {
		return true
	}
	if (providerId === "openai" || providerId === "openai-compatible") {
		return false
	}
	return undefined
}

function buildOptionalExecutionConfig() {
	const execution: Record<string, unknown> = {}
	const maxConsecutiveMistakes = readOptionalPositiveIntEnv("VSCLINE_MAX_CONSECUTIVE_MISTAKES")
	const reminderAfterIterations = readOptionalPositiveIntEnv("VSCLINE_REMINDER_AFTER_ITERATIONS")
	const loopDetection = readLoopDetectionConfig()
	if (maxConsecutiveMistakes) {
		execution.maxConsecutiveMistakes = maxConsecutiveMistakes
	}
	if (reminderAfterIterations) {
		execution.reminderAfterIterations = reminderAfterIterations
	}
	if (loopDetection !== undefined) {
		execution.loopDetection = loopDetection
	}
	return Object.keys(execution).length > 0 ? execution : undefined
}

function readLoopDetectionConfig() {
	const rawValue = process.env.VSCLINE_LOOP_DETECTION
	if (!rawValue) {
		return undefined
	}
	const raw = rawValue.trim().toLowerCase()
	if (raw === "0" || raw === "false" || raw === "off") {
		return false
	}

	return {
		softThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_SOFT_THRESHOLD") || 3,
		hardThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_HARD_THRESHOLD") || 5,
	}
}

function isTerminalSdkStatus(status: string) {
	return status === "completed" || status === "stopped" || status === "cancelled" || status === "failed" || status === "error"
}

function isSessionNotFoundError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return /session not found/i.test(message)
}

function stringify(value: unknown) {
	if (typeof value === "string") {
		return value
	}
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function formatProviderErrorForTranscript(value: unknown, language: "en" | "ko") {
	const text = stringify(value).trim()
	if (!text) {
		return language === "ko" ? "모델 제공자가 빈 오류를 반환했습니다." : "The model provider returned an empty error."
	}
	if (/too many requests|rate limit|429/i.test(text)) {
		return language === "ko"
			? `모델 제공자 응답: 요청 한도를 초과했습니다.\n\n${text}`
			: `Model provider response: rate limit exceeded.\n\n${text}`
	}
	return text
}

function isPlaceholderApiRequest(text: string) {
	const parsed = asRecord(tryParseJson(text) ?? {})
	const request = getString(parsed, "request") || text
	const normalized = request.replace(/\s+/g, " ").trim().toLowerCase()
	return (
		normalized === "cline sdk is thinking..." ||
		normalized === "thinking" ||
		normalized === "모델 진행 중" ||
		normalized === "모델 진행 기록"
	)
}

function truncateText(value: string, maxChars: number) {
	if (value.length <= maxChars) {
		return value
	}
	return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}

function getCommandText(input: Record<string, unknown>) {
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

function getToolPath(input: Record<string, unknown>) {
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

function getToolPathFromUnknown(value: unknown): string {
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

function getSearchQuery(value: unknown): string {
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

function getSearchFilePattern(value: unknown): string {
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

function summarizeToolInput(input: Record<string, unknown>) {
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

function summarizeToolOutput(tool: string, output: unknown) {
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

function getPatchPathsFromUnknown(value: unknown): string {
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

function parsePatchPaths(patchText: string) {
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

function summarizeCommandOutput(output: unknown) {
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

function summarizeCommandLabel(output: unknown) {
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

function sanitizeConsoleOutput(text: string) {
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

function stripCommandSentinel(text: string) {
	return text
		.split(/\r?\n/)
		.filter((line) => !/(?:^|>)__VSCLINE_COMMAND_(?:DONE__cmd-\d{6}__-?\d+|CWD__cmd-\d{6}__.*)\s*$/.test(line.trim()))
		.join("\n")
}

function tryParseJson(value: string) {
	try {
		return JSON.parse(value) as unknown
	} catch {
		return undefined
	}
}

function getAskResponseText(message: unknown) {
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

function firstString(record: Record<string, unknown>, keys: string[]) {
	for (const key of keys) {
		const value = getString(record, key)
		if (value.trim()) {
			return value
		}
	}
	return ""
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index])) {
			return index
		}
	}
	return -1
}

function shouldAutoApproveTool(toolName: string, autoApprovalSettings: unknown) {
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

function normalizeClineMessagePayload(message: Record<string, unknown>) {
	const normalized = { ...message }
	const text = getString(normalized, "text")
	const say = getString(normalized, "say")
	const ask = getString(normalized, "ask")

	if ((say === "tool" || ask === "tool") && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			tool: "unknown",
			content: text,
		})
	}

	if (say === "api_req_started" && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			request: text,
			tokensIn: 0,
			tokensOut: 0,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0,
			usageReliable: false,
		})
	}

	if (ask === "followup" && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			question: text,
			options: [],
		})
	}

	if (ask === "command" && text && !isJsonObjectString(text)) {
		normalized.text = JSON.stringify({
			command: text,
		})
	}

	return normalized
}

function isMeaninglessToolMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	if (say !== "tool" && ask !== "tool") {
		return false
	}

	const text = getString(message, "text")
	if (text && !isJsonObjectString(text)) {
		return false
	}

	const parsed = asRecord(tryParseJson(text || "{}") ?? {})
	return (
		!getString(parsed, "tool") &&
		!getString(parsed, "path") &&
		!getString(parsed, "content") &&
		!getString(parsed, "command") &&
		!getString(parsed, "error")
	)
}

function isMeaninglessPlaceholderMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	if (say !== "reasoning" && say !== "api_req_started") {
		return false
	}

	const text = getString(message, "text")
	if (!isEmptyTranscriptPlaceholder(text)) {
		return false
	}

	const images = Array.isArray(message.images) ? message.images : []
	const files = Array.isArray(message.files) ? message.files : []
	return images.length === 0 && files.length === 0 && !getString(message, "reasoning")
}

function isMeaninglessTextMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	if (ask || say !== "text") {
		return false
	}
	return isEmptyJsonObjectString(getString(message, "text"))
}

function isJsonObjectString(value: string) {
	try {
		const parsed = JSON.parse(value)
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
	} catch {
		return false
	}
}

function isEmptyJsonObjectString(value: string) {
	const trimmed = value.trim()
	if (trimmed !== "{}") {
		return false
	}
	try {
		const parsed = JSON.parse(trimmed)
		return isEmptyPlainObject(parsed)
	} catch {
		return false
	}
}

function isEmptyTranscriptPlaceholder(value: string) {
	const trimmed = value.trim()
	return trimmed === "{}" || trimmed === "[]" || trimmed === "null" || trimmed === "undefined"
}

function isEmptyPlainObject(value: unknown) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0
}

function toProtoClineMessage(message: Record<string, unknown>) {
	return {
		ts: numberValue(message.ts) || Date.now(),
		type: message.type === "ask" ? "ASK" : "SAY",
		ask: toProtoAsk(getString(message, "ask")),
		say: toProtoSay(getString(message, "say")),
		text: getString(message, "text"),
		reasoning: getString(message, "reasoning"),
		images: Array.isArray(message.images) ? message.images : [],
		files: Array.isArray(message.files) ? message.files : [],
		partial: message.partial === true,
		isCollapsed: message.isCollapsed === true,
		isExpanded: message.isExpanded === true,
		lastCheckpointHash: "",
		isCheckpointCheckedOut: false,
		isOperationOutsideWorkspace: false,
		conversationHistoryIndex: 0,
	}
}

function toProtoAsk(ask: string) {
	const mapping: Record<string, string> = {
		followup: "FOLLOWUP",
		plan_mode_respond: "PLAN_MODE_RESPOND",
		act_mode_respond: "ACT_MODE_RESPOND",
		command: "COMMAND",
		command_output: "COMMAND_OUTPUT",
		completion_result: "COMPLETION_RESULT",
		tool: "TOOL",
		api_req_failed: "API_REQ_FAILED",
		resume_task: "RESUME_TASK",
		resume_completed_task: "RESUME_COMPLETED_TASK",
		mistake_limit_reached: "MISTAKE_LIMIT_REACHED",
		browser_action_launch: "BROWSER_ACTION_LAUNCH",
		use_mcp_server: "USE_MCP_SERVER",
		new_task: "NEW_TASK",
		condense: "CONDENSE",
		summarize_task: "SUMMARIZE_TASK",
		report_bug: "REPORT_BUG",
		use_subagents: "USE_SUBAGENTS",
	}
	return mapping[ask] || "FOLLOWUP"
}

function toProtoSay(say: string) {
	const mapping: Record<string, string> = {
		task: "TASK",
		error: "ERROR",
		api_req_started: "API_REQ_STARTED",
		api_req_finished: "API_REQ_FINISHED",
		text: "TEXT",
		reasoning: "REASONING",
		completion_result: "COMPLETION_RESULT_SAY",
		user_feedback: "USER_FEEDBACK",
		user_feedback_diff: "USER_FEEDBACK_DIFF",
		api_req_retried: "API_REQ_RETRIED",
		command: "COMMAND_SAY",
		command_output: "COMMAND_OUTPUT_SAY",
		tool: "TOOL_SAY",
		info: "INFO",
		task_progress: "TASK_PROGRESS",
		hook_status: "HOOK_STATUS",
		hook_output_stream: "HOOK_OUTPUT_STREAM",
	}
	return mapping[say] || "TEXT"
}

function buildTaskInputWithAttachments(text: string, images: string[], files: string[]) {
	const attachments = [
		...images.map((image) => `Image: ${formatAttachmentSummaryValue(image)}`),
		...files.map((file) => `File: ${file}`),
	]
	return attachments.length > 0 ? `${text}\n\nAttachments:\n${attachments.join("\n")}` : text
}

function normalizeSdkImageInputs(images: string[]) {
	return images.map((image) => normalizeSdkImageInput(image)).filter(Boolean)
}

function normalizeSdkImageInput(image: string) {
	const trimmed = image.trim()
	if (!trimmed) {
		return ""
	}

	if (/^(https?:|data:image\/)/i.test(trimmed)) {
		return trimmed
	}

	const localPath = trimmed.startsWith("file://") ? fileUrlToPath(trimmed) : trimmed
	const dataUri = tryCreateImageDataUri(localPath)
	return dataUri
}

function fileUrlToPath(value: string) {
	try {
		return decodeURIComponent(value.replace(/^file:\/\/\/?/i, "")).replace(/\//g, path.sep)
	} catch {
		return value
	}
}

function tryCreateImageDataUri(filePath: string) {
	try {
		if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			return ""
		}

		const mimeType = getImageMimeType(filePath)
		if (!mimeType) {
			return ""
		}

		return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`
	} catch {
		return ""
	}
}

function getImageMimeType(filePath: string) {
	const extension = path.extname(filePath).toLowerCase()
	switch (extension) {
		case ".png":
			return "image/png"
		case ".jpg":
		case ".jpeg":
			return "image/jpeg"
		case ".gif":
			return "image/gif"
		case ".webp":
			return "image/webp"
		case ".bmp":
			return "image/bmp"
		default:
			return ""
	}
}

function formatAttachmentSummaryValue(value: string) {
	if (value.toLowerCase().startsWith("data:image/")) {
		const separatorIndex = value.toLowerCase().indexOf(";base64,")
		const mimeType = separatorIndex > "data:".length ? value.slice("data:".length, separatorIndex) : "image"
		return `[attached ${mimeType}]`
	}

	return value
}

function getExternalUrlValue(message: unknown) {
	return getString(message, "value") || getString(message, "url") || getString(message, "uri") || getString(message, "href")
}

function normalizeMcpDisplayMode(value: unknown, fallback: unknown = "plain") {
	const normalized = String(value || "").trim().toLowerCase()
	if (normalized === "rich" || normalized === "plain" || normalized === "markdown") {
		return normalized
	}

	const fallbackNormalized = String(fallback || "").trim().toLowerCase()
	return fallbackNormalized === "rich" || fallbackNormalized === "markdown" ? fallbackNormalized : "plain"
}

function createId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function createHistoryItem(id: string, task: string, cwd: string, modelId: string) {
	return {
		id,
		ts: Date.now(),
		task,
		tokensIn: 0,
		tokensOut: 0,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
		isFavorited: false,
		size: 0,
		cwdOnTaskInitialization: cwd,
		modelId,
	}
}

function sdkSessionToHistoryItem(session: Record<string, unknown>) {
	const metadata = asRecord(session.metadata)
	const usage = normalizeUsageSnapshot(
		metadata.aggregateUsage || metadata.usage || session.aggregateUsage || session.usage || asRecord(session.snapshot).aggregateUsage,
	)
	const checkpoint = asRecord(metadata.checkpoint)
	const latestCheckpoint = asRecord(checkpoint.latest)
	const id = getString(session, "sessionId") || getString(session, "id") || createId()
	const task = getString(metadata, "title") || getString(session, "title") || getString(session, "prompt") || "LIG VS SDK task"
	return {
		id,
		ts: getNumber(session, "updatedAt") || getNumber(session, "createdAt") || Date.now(),
		task,
		tokensIn: usage.inputTokens || 0,
		tokensOut: usage.outputTokens || 0,
		cacheWrites: usage.cacheWriteTokens || 0,
		cacheReads: usage.cacheReadTokens || 0,
		totalCost: getNumber(metadata, "totalCost") || usage.totalCost || 0,
		isFavorited: metadata.isFavorited === true,
		size: getNumber(session, "messageCount") || 0,
		cwdOnTaskInitialization: getString(session, "cwd") || getString(metadata, "cwd") || process.cwd(),
		modelId: getString(metadata, "modelId") || getString(session, "modelId") || "",
		latestCheckpointRunCount: getNumber(latestCheckpoint, "runCount"),
	}
}

function removeDeletedHistoryItems(items: Array<Record<string, unknown>>, deletedTaskIds: Set<string>) {
	if (deletedTaskIds.size === 0) {
		return items
	}
	return items.filter((item) => !deletedTaskIds.has(String(item.id || "")))
}

function sdkMessagesToClineMessages(messages: unknown, taskItem: Record<string, unknown>) {
	if (!Array.isArray(messages)) {
		return []
	}

	const result: Array<Record<string, unknown>> = []
	const toolEntries: ToolActivityEntry[] = []
	const reasoningParts: string[] = []
	let messageIndex = 0
	const flushToolEntries = (ts: number) => {
		const uniqueEntries = uniqueToolActivityEntries(toolEntries)
		if (uniqueEntries.length === 0) {
			return
		}

		result.push({
			ts,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request: buildGroupedToolActivityText(uniqueEntries, false),
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				cost: 0,
				usageReliable: false,
			}),
			partial: false,
			isCollapsed: true,
			isExpanded: false,
		})
		toolEntries.length = 0
	}
	const flushReasoning = (ts: number) => {
		const reasoning = uniqueStrings(reasoningParts)
			.filter((part) => part && part !== "모델 진행 중")
			.join("\n\n")
		if (!reasoning) {
			reasoningParts.length = 0
			return
		}

		result.push({
			ts,
			type: "say",
			say: "reasoning",
			text: "모델 내부 추론",
			reasoning,
			partial: false,
			isCollapsed: true,
			isExpanded: false,
		})
		reasoningParts.length = 0
	}

	for (const message of messages) {
		const record = asRecord(message)
		const role = getString(record, "role")
		const ts = sdkMessageTimestamp(record, taskItem, messageIndex++)
		let partOffset = 0
		if (role === "user") {
			const text = contentToText(record.content)
			const entries = sdkContentToToolActivityEntries(record.content)
			if (result.length === 0) {
				result.push({ ts: ts + partOffset++, type: "say", say: "task", text })
			} else if (entries.length > 0) {
				toolEntries.push(...entries)
			} else if (text.trim()) {
				flushToolEntries(ts + partOffset++)
				flushReasoning(ts + partOffset++)
				result.push({ ts: ts + partOffset++, type: "say", say: "user_feedback", text })
			}
		} else if (role === "assistant") {
			const entries = sdkContentToToolActivityEntries(record.content)
			if (entries.length > 0) {
				toolEntries.push(...entries)
			}
			const folded = sdkContentToReasoningText(record.content)
			if (folded) {
				reasoningParts.push(folded)
			}
			const text = sdkContentToVisibleAssistantText(record.content)
			if (text) {
				flushToolEntries(ts + partOffset++)
				flushReasoning(ts + partOffset++)
				result.push({ ts: ts + partOffset++, type: "say", say: "text", text })
			}
		}

		const metadata = asRecord(record.metadata)
		const checkpointRunCount = getNumber(metadata, "checkpointRunCount")
		if (checkpointRunCount !== undefined) {
			result.push({
				ts: ts + partOffset++,
				type: "say",
				say: "checkpoint_created",
				text: "SDK checkpoint",
				checkpointRunCount,
				checkpointTaskItem: taskItem,
			})
		}
	}
	const tailTs = stableSessionBaseTimestamp(taskItem) + (messageIndex + 1) * 10
	flushToolEntries(tailTs)
	flushReasoning(tailTs + 1)
	return result
}

function sdkMessageTimestamp(message: Record<string, unknown>, taskItem: Record<string, unknown>, index: number) {
	const explicit =
		getNumber(message, "ts") ??
		getNumber(message, "timestamp") ??
		getNumber(message, "createdAt") ??
		getNumber(message, "updatedAt")
	if (explicit !== undefined) {
		return normalizeTimestamp(explicit) + index * 10
	}

	return stableSessionBaseTimestamp(taskItem) + index * 10
}

function normalizeTimestamp(value: number) {
	return value > 0 && value < 10_000_000_000 ? value * 1000 : value
}

function stableSessionBaseTimestamp(taskItem: Record<string, unknown>) {
	const id = getString(taskItem, "id") || getString(taskItem, "task") || "cline-sdk-session"
	return 1_700_000_000_000 + (hashString(id) % 1_000_000_000)
}

function hashString(value: string) {
	let hash = 2166136261
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

function partialMessageDeliveryKey(message: Record<string, unknown>) {
	return JSON.stringify({
		ts: numberValue(message.ts),
		type: getString(message, "type"),
		ask: getString(message, "ask"),
		say: getString(message, "say"),
		text: getString(message, "text"),
		reasoning: getString(message, "reasoning"),
		partial: message.partial === true,
		isCollapsed: message.isCollapsed === true,
		isExpanded: message.isExpanded === true,
	})
}

function sdkContentToVisibleAssistantText(content: unknown): string {
	if (typeof content === "string") {
		return normalizeAssistantTranscriptText(content)
	}
	if (!Array.isArray(content)) {
		return ""
	}

	const text = content
		.map((block) => {
			const record = asRecord(block)
			if (getString(record, "type") !== "text") {
				return ""
			}
			return getString(record, "text")
		})
		.filter(Boolean)
		.join("\n\n")
	return normalizeAssistantTranscriptText(text)
}

function sdkContentToReasoningText(content: unknown): string {
	if (!Array.isArray(content)) {
		return ""
	}

	const parts = content
		.map((block) => {
			const record = asRecord(block)
			const type = getString(record, "type")
			if (type === "thinking") {
				return normalizeReasoningTranscriptText(getString(record, "thinking"))
			}
			return ""
		})
		.filter(Boolean)
		.join("\n\n")

	return normalizeProgressTranscriptText(parts)
}

function sdkContentToToolActivityEntries(content: unknown): ToolActivityEntry[] {
	if (typeof content === "string") {
		return isToolTranscript(content) ? toolTranscriptToActivityEntries(content) : []
	}
	if (!Array.isArray(content)) {
		return []
	}

	return content.flatMap((block) => {
		const record = asRecord(block)
		const type = getString(record, "type")
		if (type === "tool_use") {
			return toolTranscriptToActivityEntries(`Tool: ${getString(record, "name") || "tool"}\n${toolInputToText(record.input)}`)
		}
		if (type === "tool_result") {
			return toolTranscriptToActivityEntries(`Tool result: ${toolResultToText(record.content)}`)
		}
		if (type === "file") {
			const pathValue = getString(record, "path")
			return pathValue ? [{ kind: "file", label: pathValue }] : []
		}
		if (type === "text") {
			const text = getString(record, "text")
			return isToolTranscript(text) ? toolTranscriptToActivityEntries(text) : []
		}
		return []
	})
}

function contentToText(content: unknown): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		if (isEmptyPlainObject(content)) {
			return ""
		}
		return stringify(content)
	}
	return content.map((block) => {
		const record = asRecord(block)
		const type = getString(record, "type")
		if (type === "text") {
			return getString(record, "text")
		}
		if (type === "thinking") {
			return getString(record, "thinking")
		}
		if (type === "tool_use") {
			return `Tool: ${getString(record, "name")}\n${toolInputToText(record.input)}`
		}
		if (type === "tool_result") {
			return `Tool result: ${toolResultToText(record.content)}`
		}
		if (type === "file") {
			return `File: ${getString(record, "path")}\n${getString(record, "content")}`
		}
		if (type === "image") {
			return "[image]"
		}
		return stringify(record)
	}).filter(Boolean).join("\n\n")
}

function extractCompletionTextFromResult(result: Record<string, unknown>, event: unknown): string {
	const eventRecord = asRecord(event)
	const candidates: unknown[] = [
		result.outputText,
		result.finalText,
		result.finalResponse,
		result.response,
		result.answer,
		result.text,
		eventRecord.outputText,
		eventRecord.finalText,
		eventRecord.finalResponse,
		eventRecord.response,
		eventRecord.answer,
		eventRecord.text,
		result.message,
		result.content,
		result.output,
		result.result,
		eventRecord.message,
		eventRecord.content,
		eventRecord.output,
	]

	for (const candidate of candidates) {
		const text = completionCandidateToText(candidate)
		if (text) {
			return text
		}
	}

	return ""
}

function completionCandidateToText(value: unknown): string {
	if (value === undefined || value === null) {
		return ""
	}
	if (typeof value === "string") {
		return normalizeAssistantTranscriptText(value)
	}
	if (Array.isArray(value)) {
		return normalizeAssistantTranscriptText(completionContentBlocksToText(value))
	}
	const record = asRecord(value)
	if (Object.keys(record).length === 0) {
		return ""
	}

	for (const key of ["outputText", "finalText", "finalResponse", "response", "answer", "text", "message", "content", "output"]) {
		const text = completionCandidateToText(record[key])
		if (text) {
			return text
		}
	}

	return ""
}

function completionContentBlocksToText(content: unknown[]): string {
	return content.map((block) => {
		if (typeof block === "string") {
			return block
		}
		const record = asRecord(block)
		const type = getString(record, "type")
		if (type === "text") {
			return getString(record, "text")
		}
		if (!type) {
			return completionCandidateToText(record)
		}
		return ""
	}).filter(Boolean).join("\n\n")
}

function agentChunkToTranscriptText(chunk: unknown): string {
	if (typeof chunk === "string") {
		return agentChunkStringToTranscriptText(chunk)
	}

	const record = asRecord(chunk)
	if (Object.keys(record).length === 0) {
		return ""
	}

	const transcript = agentChunkRecordToTranscriptText(record)
	if (transcript || isKnownAgentEventRecord(record) || getString(record, "type")) {
		return transcript
	}
	return contentToText(chunk)
}

function agentChunkToFoldedReasoningText(chunk: unknown): string {
	if (typeof chunk === "string") {
		return agentChunkStringToFoldedReasoningText(chunk)
	}

	const record = asRecord(chunk)
	if (Object.keys(record).length === 0) {
		return ""
	}

	return agentChunkRecordToFoldedReasoningText(record)
}

function agentChunkToTerminalResult(chunk: unknown): { status: string; reason: string; text: string } | null {
	if (typeof chunk === "string") {
		const text = chunk.trim()
		if (!text) {
			return null
		}

		const parsed = tryParseJson(text)
		if (parsed !== undefined) {
			return agentChunkToTerminalResult(parsed)
		}

		const sequence = parseJsonObjectSequence(text)
		for (let index = sequence.length - 1; index >= 0; index--) {
			const terminal = agentChunkToTerminalResult(sequence[index])
			if (terminal) {
				return terminal
			}
		}

		const jsonLines = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => tryParseJson(line))
		if (jsonLines.length > 0 && jsonLines.every((item) => item !== undefined)) {
			for (let index = jsonLines.length - 1; index >= 0; index--) {
				const terminal = agentChunkToTerminalResult(jsonLines[index])
				if (terminal) {
					return terminal
				}
			}
		}

		return null
	}

	if (Array.isArray(chunk)) {
		for (let index = chunk.length - 1; index >= 0; index--) {
			const terminal = agentChunkToTerminalResult(chunk[index])
			if (terminal) {
				return terminal
			}
		}
		return null
	}

	return agentChunkRecordToTerminalResult(asRecord(chunk))
}

function agentChunkRecordToTerminalResult(record: Record<string, unknown>): { status: string; reason: string; text: string } | null {
	const type = getString(record, "type")
	if (type === "done") {
		return {
			status: getString(record, "status") || "completed",
			reason: getString(record, "reason") || "done",
			text: getString(record, "text"),
		}
	}
	if (type === "run-finished") {
		const result = asRecord(record.result)
		return {
			status: getString(result, "status") || "completed",
			reason: "run-finished",
			text: getString(result, "outputText") || getString(record, "text"),
		}
	}
	if (type === "run-failed") {
		return {
			status: "failed",
			reason: "run-failed",
			text: getString(record, "text") || stringify(record.error),
		}
	}
	return null
}

function agentChunkStringToTranscriptText(chunk: string): string {
	const text = chunk.trim()
	if (!text) {
		return ""
	}

	const parsed = tryParseJson(text)
	if (parsed !== undefined) {
		if (Array.isArray(parsed)) {
			return parsed.map((item) => agentChunkToTranscriptText(item)).filter(Boolean).join("\n\n")
		}

		const parsedRecord = asRecord(parsed)
		const parsedText = agentChunkRecordToTranscriptText(parsedRecord)
		if (parsedText) {
			return parsedText
		}
		if (isKnownAgentEventRecord(parsedRecord)) {
			return ""
		}
	}

	const sequence = parseJsonObjectSequence(text)
	if (sequence.length > 0) {
		const sequenceText = sequence.map((item) => agentChunkToTranscriptText(item)).filter(Boolean).join("\n\n")
		if (sequenceText || sequence.length > 0) {
			return sequenceText
		}
	}

	const jsonLines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => tryParseJson(line))
	if (jsonLines.length > 0 && jsonLines.every((item) => item !== undefined)) {
		const lineText = jsonLines.map((item) => agentChunkToTranscriptText(item)).filter(Boolean).join("\n\n")
		return lineText
	}

	return unknownAgentChunkTextToTranscriptText(text)
}

function agentChunkStringToFoldedReasoningText(chunk: string): string {
	const text = chunk.trim()
	if (!text) {
		return ""
	}

	const parsed = tryParseJson(text)
	if (parsed !== undefined) {
		if (Array.isArray(parsed)) {
			return parsed.map((item) => agentChunkToFoldedReasoningText(item)).filter(Boolean).join("\n")
		}

		return agentChunkRecordToFoldedReasoningText(asRecord(parsed))
	}

	const sequence = parseJsonObjectSequence(text)
	if (sequence.length > 0) {
		return sequence.map((item) => agentChunkToFoldedReasoningText(item)).filter(Boolean).join("\n")
	}

	const jsonLines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => tryParseJson(line))
	if (jsonLines.length > 0 && jsonLines.every((item) => item !== undefined)) {
		return jsonLines.map((item) => agentChunkToFoldedReasoningText(item)).filter(Boolean).join("\n")
	}

	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	if (looksLikeTokenizedReasoning(lines)) {
		return ""
	}
	if (looksLikeReasoningNarration(text)) {
		return normalizeReasoningTranscriptText(text)
	}

	return ""
}

function parseJsonObjectSequence(text: string) {
	const results: unknown[] = []
	let depth = 0
	let start = -1
	let inString = false
	let escaped = false

	for (let index = 0; index < text.length; index++) {
		const char = text[index]
		if (inString) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === "\"") {
				inString = false
			}
			continue
		}

		if (char === "\"") {
			inString = true
			continue
		}

		if (char === "{") {
			if (depth === 0) {
				start = index
			}
			depth++
		} else if (char === "}" && depth > 0) {
			depth--
			if (depth === 0 && start >= 0) {
				const parsed = tryParseJson(text.slice(start, index + 1))
				if (parsed === undefined) {
					return []
				}
				results.push(parsed)
				start = -1
			}
		}
	}

	return depth === 0 && results.length > 1 ? results : []
}

function agentChunkRecordToTranscriptText(record: Record<string, unknown>): string {
	const type = getString(record, "type")
	if (!type) {
		const role = getString(record, "role")
		if (role) {
			return contentToText(record.content)
		}
		return ""
	}

	if (type === "iteration_start" || type === "iteration_end" || type === "usage" || type === "done") {
		return ""
	}

	if (type === "content_start" || type === "content_update" || type === "content_delta" || type === "content_end") {
		const contentType = getString(record, "contentType") || getString(record, "content_type")
		const text = agentContentEventToText(record)
		if (!text.trim() || contentType === "reasoning") {
			return ""
		}
		if (contentType === "text" && type !== "content_end") {
			return ""
		}
		if (contentType === "text" && (shouldDropTokenizedReasoning(text) || shouldFoldTextContentAsReasoning(text))) {
			return ""
		}
		return text
	}

	if (type === "text" || type === "thinking") {
		return ""
	}

	if (type === "tool_use" || type === "tool_result" || type === "file" || type === "image") {
		return contentToText([record])
	}

	if (type === "notice" || type === "status" || type === "error") {
		return firstString(record, ["message", "text", "error", "status"])
	}

	return ""
}

function agentChunkRecordToFoldedReasoningText(record: Record<string, unknown>): string {
	const type = getString(record, "type")
	if (!type) {
		return ""
	}

	if (type === "content_start" || type === "content_update" || type === "content_delta" || type === "content_end") {
		const contentType = getString(record, "contentType") || getString(record, "content_type")
		if (contentType === "reasoning") {
			const text = agentContentEventToText(record)
			return shouldDropTokenizedReasoning(text) ? "" : normalizeReasoningTranscriptText(text)
		}
		if (contentType === "text") {
			const text = agentContentEventToText(record)
			if (type === "content_end") {
				return ""
			}
			return shouldFoldTextContentAsReasoning(text) ? normalizeReasoningTranscriptText(text) : ""
		}
		return ""
	}

	if (type === "thinking") {
		return normalizeReasoningTranscriptText(contentToText([record]))
	}

	return ""
}

function isKnownAgentEventRecord(record: Record<string, unknown>) {
	const type = getString(record, "type")
	return Boolean(type) && (
		type === "iteration_start" ||
		type === "iteration_end" ||
		type === "usage" ||
		type === "done" ||
		type === "content_start" ||
		type === "content_update" ||
		type === "content_delta" ||
		type === "content_end" ||
		type === "notice" ||
		type === "status" ||
		type === "error"
	)
}

function agentContentEventToText(record: Record<string, unknown>): string {
	const contentType = getString(record, "contentType") || getString(record, "content_type")
	if (contentType === "text" || contentType === "reasoning") {
		return firstString(record, ["text", "reasoning", "content", "accumulated", "delta"])
	}

	if (contentType === "tool" || contentType === "tool_use" || contentType === "tool_result") {
		const toolName = firstString(record, ["name", "toolName", "tool_name", "id"])
		const input = record.input ?? record.arguments ?? record.params ?? record.message
		const output = record.output ?? record.result ?? record.content
		if (output !== undefined) {
			return `Tool result: ${toolResultToText(output)}`
		}
		if (toolName || input !== undefined) {
			return `Tool: ${toolName || "tool"}${input !== undefined ? `\n${toolInputToText(input)}` : ""}`
		}
	}

	return ""
}

function unknownAgentChunkTextToTranscriptText(text: string) {
	const trimmed = text.trim()
	if (!trimmed) {
		return ""
	}

	if (trimmed.startsWith("{\"type\":") || trimmed.startsWith("{'type':")) {
		return ""
	}

	const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	if (trimmed.length < 40 && !isToolTranscript(trimmed)) {
		return ""
	}
	if (looksLikeTokenizedReasoning(lines)) {
		return ""
	}
	if (!isToolTranscript(trimmed)) {
		return ""
	}

	return lines.length > 1 ? lines.join("\n") : trimmed
}

function shouldDropTokenizedReasoning(text: string) {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	return looksLikeTokenizedReasoning(lines)
}

function shouldFoldTextContentAsReasoning(text: string) {
	return !shouldDropTokenizedReasoning(text) && looksLikeReasoningNarration(text)
}

function shouldDelayAssistantTextUntilClassified(text: string) {
	const normalized = text.replace(/\s+/g, " ").trim()
	if (!normalized) {
		return false
	}
	if (normalized.length < 80) {
		return true
	}
	const lower = normalized.toLowerCase()
	return [
		"the user",
		"user ",
		"we ",
		"let",
		"probably",
		"maybe",
		"need ",
		"i ",
	].some((prefix) => lower.startsWith(prefix))
}

function stripRawToolCallMarkup(text: string) {
	return text
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/invoke>\s*<\/[^>\s]*:?tool_call>/gi, "")
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/invoke>/gi, "")
		.replace(/<function=[\s\S]*?<\/function>\s*<\/tool_call>/gi, "")
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/tool_call>/gi, "")
		.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
		.replace(/<\/?[^>\s]*:?tool_call>/gi, "")
		.trim()
}

function normalizeReasoningTranscriptText(text: string) {
	const trimmed = stripRawToolCallMarkup(text)
	if (!trimmed) {
		return ""
	}

	const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	if (looksLikeTokenizedReasoning(lines)) {
		return ""
	}

	return trimmed.replace(/\s+/g, " ")
}

function normalizeProgressTranscriptText(text: string) {
	const trimmed = stripRawToolCallMarkup(text)
	if (!trimmed) {
		return ""
	}

	return trimmed
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
}

function sanitizeProgressTranscriptForDisplay(text: string) {
	return stripRawToolCallMarkup(text)
		.split(/\r?\n/)
		.filter((line) => !isEmptyTranscriptPlaceholder(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

function normalizeAssistantTranscriptText(text: string) {
	const trimmed = stripRawToolCallMarkup(text)
	if (!trimmed || isEmptyJsonObjectString(trimmed)) {
		return ""
	}

	return trimmed.replace(/\n{3,}/g, "\n\n")
}

const RESUMED_CONVERSATION_MAX_MESSAGES = 40
const RESUMED_CONVERSATION_MAX_CHARS = 20_000
const RESUMED_CONVERSATION_MAX_ENTRY_CHARS = 2_500

function buildResumedConversationPrompt(messages: Array<Record<string, unknown>>, prompt: string, uiLanguage: string) {
	const currentPrompt = prompt.trim()
	const entries = messages
		.filter((message) => message.partial !== true)
		.map(clineMessageToResumedTranscriptEntry)
		.filter((entry): entry is { role: string; text: string } => Boolean(entry?.text))

	while (entries.length > 0 && normalizeTranscriptText(entries[entries.length - 1].text) === normalizeTranscriptText(currentPrompt)) {
		entries.pop()
	}

	if (entries.length === 0 || !currentPrompt) {
		return prompt
	}

	const selected: string[] = []
	let totalChars = currentPrompt.length
	for (let index = entries.length - 1; index >= 0 && selected.length < RESUMED_CONVERSATION_MAX_MESSAGES; index--) {
		const entry = entries[index]
		const line = `${entry.role}:\n${truncateText(entry.text, RESUMED_CONVERSATION_MAX_ENTRY_CHARS)}`
		if (totalChars + line.length > RESUMED_CONVERSATION_MAX_CHARS) {
			if (selected.length > 0) {
				break
			}
			selected.unshift(truncateText(line, Math.max(1_000, RESUMED_CONVERSATION_MAX_CHARS - totalChars)))
			break
		}
		selected.unshift(line)
		totalChars += line.length
	}

	if (selected.length === 0) {
		return prompt
	}

	const korean = uiLanguage === "ko"
	const header = korean
		? "아래는 Visual Studio 재시작 후 복원된 이전 대화 기록입니다. 이 기록을 현재 대화 문맥으로 사용해 이어서 답하세요."
		: "The following is the previous conversation restored after Visual Studio restarted. Use it as context and continue the conversation."
	const currentLabel = korean ? "현재 사용자 메시지" : "Current user message"
	return `${header}\n\n${selected.join("\n\n")}\n\n${currentLabel}:\n${currentPrompt}`
}

function clineMessageToResumedTranscriptEntry(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	const text = resumedTranscriptTextForMessage(message)
	if (!text) {
		return null
	}

	if (say === "task" || say === "user_feedback") {
		return { role: "User", text }
	}
	if (say === "text") {
		return { role: "Assistant", text }
	}
	if (say === "tool" || say === "command_output" || say === "browser_action" || ask === "tool" || ask === "command") {
		return { role: "Tool", text }
	}
	if (ask === "followup" || ask === "plan_mode_respond" || ask === "act_mode_respond") {
		return { role: "Assistant", text }
	}
	if (say === "error" || ask === "api_req_failed") {
		return { role: "System", text }
	}
	return null
}

function resumedTranscriptTextForMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	const text = getString(message, "text")
	if (!text || say === "completion_result" || ask === "completion_result" || say === "api_req_started" || say === "reasoning") {
		return ""
	}

	const parsed = asRecord(tryParseJson(text) ?? {})
	if (Object.keys(parsed).length === 0) {
		return normalizeAssistantTranscriptText(text)
	}

	if (ask === "command") {
		return getString(parsed, "command") || normalizeAssistantTranscriptText(text)
	}
	if (ask === "followup") {
		const question = getString(parsed, "question")
		const options = getStringArray(parsed, "options")
		return [question, options.length ? `Options: ${options.join(", ")}` : ""].filter(Boolean).join("\n")
	}
	if (say === "tool" || ask === "tool") {
		const label = getString(parsed, "tool") || getString(parsed, "path") || getString(parsed, "command") || "tool"
		const content = getString(parsed, "content") || getString(parsed, "error") || stringify(parsed)
		return `${label}\n${content}`
	}
	return normalizeAssistantTranscriptText(text)
}

function mergeTextDelta(current: string, delta: string) {
	if (!delta) {
		return current
	}
	if (!current) {
		return delta
	}
	return current.endsWith(delta) ? current : current + delta
}

function looksLikeTokenizedReasoning(lines: string[]) {
	if (lines.length < 5) {
		return false
	}

	const shortLines = lines.filter((line) => line.length <= 16).length
	const wordLikeShortLines = lines.filter((line) => /^[A-Za-z0-9가-힣'"().,!?-]+$/.test(line) && line.length <= 12).length
	const avgLength = lines.reduce((total, line) => total + line.length, 0) / lines.length
	return (shortLines / lines.length >= 0.72 && avgLength <= 12) || wordLikeShortLines / lines.length >= 0.6
}

function looksLikeReasoningNarration(text: string) {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase()
	return normalized.startsWith("the user says") ||
		normalized.startsWith("user says") ||
		normalized.startsWith("no specific task") ||
		normalized.includes(" the user says ") ||
		normalized.startsWith("we need to") ||
		normalized.startsWith("probably ") ||
		normalized.startsWith("let's ") ||
		normalized.startsWith("i need to")
}

function isToolTranscript(text: string) {
	const normalized = text.trim()
	return normalized.startsWith("Tool:") || normalized.startsWith("Tool result:")
}

function toolInputToText(input: unknown): string {
	const record = asRecord(input)
	const command = getString(record, "command")
	const files = Array.isArray(record.files) ? record.files.map((item) => asRecord(item)) : []
	const query = getString(record, "query")
	const pathValue = getString(record, "path")
	const patch = getString(record, "patch")
	if (command) {
		return command
	}
	if (files.length > 0) {
		return files.map((file) => {
			const pathText = getString(file, "path")
			const startLine = getNumber(file, "start_line")
			const endLine = getNumber(file, "end_line")
			if (startLine !== undefined || endLine !== undefined) {
				return `${pathText}:${startLine ?? 1}-${endLine ?? ""}`
			}
			return pathText
		}).filter(Boolean).join("\n")
	}
	if (query) {
		return query
	}
	if (pathValue) {
		return pathValue
	}
	if (patch) {
		return parsePatchPaths(patch).join("\n") || patch
	}
	return stringify(input)
}

function toolResultToText(result: unknown): string {
	const text = contentToText(result)
	const parsed = tryParseJson(text)
	if (parsed !== undefined) {
		const summarized = summarizeCommandOutput(parsed)
		if (summarized && summarized !== stringify(parsed)) {
			return summarized
		}
		return stringifyPretty(parsed)
	}

	return text
}

function stringifyPretty(value: unknown) {
	if (typeof value === "string") {
		return value
	}
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function normalizeTranscriptText(text: string) {
	return text.replace(/\s+/g, " ").trim()
}

function findCheckpointRunCount(messages: Array<Record<string, unknown>>, messageTs?: number) {
	if (messageTs !== undefined) {
		const target = messages.find((message) => message.ts === messageTs)
		const targetRunCount = getNumber(target, "checkpointRunCount")
		if (targetRunCount !== undefined) {
			return targetRunCount
		}
	}

	for (let index = messages.length - 1; index >= 0; index--) {
		const runCount = getNumber(messages[index], "checkpointRunCount")
		if (runCount !== undefined) {
			return runCount
		}
	}
	return undefined
}

function findCheckpointMessage(messages: Array<Record<string, unknown>>, checkpointRunCount: number, messageTs?: number) {
	if (messageTs !== undefined) {
		const target = messages.find((message) => message.ts === messageTs)
		if (getNumber(target, "checkpointRunCount") === checkpointRunCount) {
			return target
		}
	}

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (getNumber(message, "checkpointRunCount") === checkpointRunCount) {
			return message
		}
	}
	return undefined
}

function buildSettingsToggleMap(items: Array<Record<string, unknown>>, scope: "global" | "local") {
	return Object.fromEntries(
		items
			.filter((item) => (scope === "global" ? isGlobalSettingsItem(item) : !isGlobalSettingsItem(item)))
			.map((item) => [settingsItemKey(item), item.enabled !== false]),
	)
}

function isGlobalSettingsItem(item: Record<string, unknown>) {
	const source = getString(item, "source")
	return source === "global" || source === "global-plugin" || getString(item, "path").toLowerCase().includes("\\cline\\")
}

function settingsItemKey(item: Record<string, unknown>) {
	return getString(item, "path") || getString(item, "id") || getString(item, "name") || createId()
}

function settingsItemToSkillInfo(item: Record<string, unknown>) {
	return {
		name: getString(item, "name") || settingsItemKey(item),
		path: settingsItemKey(item),
		enabled: item.enabled !== false,
		description: getString(item, "description"),
	}
}

function normalizeChangePath(filePath: string) {
	return path.resolve(filePath).toLowerCase()
}

function mapToolName(toolName: string) {
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

function toolActivityEntriesFromMessage(tool: string, text: string): ToolActivityEntry[] {
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

function toolTranscriptToActivityEntries(text: string): ToolActivityEntry[] {
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

function buildGroupedToolActivityText(entries: ToolActivityEntry[], running: boolean, language: "en" | "ko" = "ko") {
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

function formatToolActivitySection(title: string, values: string[], limit: number, language: "en" | "ko" = "ko") {
	if (values.length === 0) {
		return ""
	}
	const visible = values.slice(0, Math.max(1, limit)).map((value) => `- ${value}`)
	const hiddenCount = values.length - visible.length
	return `${title}:\n${visible.join("\n")}${hiddenCount > 0 ? `\n- ... ${language === "ko" ? `${hiddenCount}개 더 있음` : `${hiddenCount} more`}` : ""}`
}

function buildTerminalActivityText(
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

function formatCompletedCommandActivity(text: string, language: "en" | "ko" = "ko") {
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

function normalizeTerminalOutputText(text: string) {
	return stripCommandSentinel(text).replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter(Boolean).join(" / ")
}

function toolActivityEntryKey(entry: ToolActivityEntry) {
	return `${entry.kind}:${entry.label}:${entry.detail || ""}`.toLowerCase()
}

function uniqueToolActivityEntries(entries: ToolActivityEntry[]) {
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

function splitToolPaths(text: string) {
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

function looksLikeCommandText(text: string) {
	const normalized = text.trim().toLowerCase()
	return normalized.startsWith("cmd ") ||
		normalized.startsWith("cmd/") ||
		normalized.startsWith("powershell ") ||
		normalized.startsWith("pwsh ") ||
		normalized.startsWith("dir ") ||
		normalized.startsWith("type ") ||
		normalized.includes(" /c ")
}

function uniqueStrings(values: string[]) {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

const protoApiProviderIds: Record<number, string> = {
	0: "anthropic",
	1: "openrouter",
	2: "bedrock",
	3: "vertex",
	4: "openai",
	5: "ollama",
	6: "lmstudio",
	7: "gemini",
	8: "openai-native",
	9: "requesty",
	10: "together",
	11: "deepseek",
	12: "qwen",
	13: "doubao",
	14: "mistral",
	15: "vscode-lm",
	16: "cline",
	17: "litellm",
	18: "nebius",
	19: "fireworks",
	20: "asksage",
	21: "xai",
	22: "sambanova",
	23: "cerebras",
	24: "groq",
	25: "sapaicore",
	26: "claude-code",
	27: "moonshot",
	28: "huggingface",
	29: "huawei-cloud-maas",
	30: "baseten",
	31: "zai",
	32: "vercel-ai-gateway",
	33: "qwen-code",
	34: "dify",
	35: "oca",
	36: "minimax",
	37: "hicap",
	38: "aihubmix",
	39: "nousResearch",
	40: "openai-codex",
	41: "wandb",
}

function normalizeProviderValue(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) {
		return protoApiProviderIds[value] || "anthropic"
	}
	if (typeof value === "string") {
		return normalizeProviderId(value)
	}
	const record = asRecord(value)
	const name = getString(record, "name")
	if (name) {
		return normalizeProviderId(name)
	}
	const id = numberValue(record.id) ?? numberValue(record.value)
	if (id !== undefined) {
		return protoApiProviderIds[id] || "anthropic"
	}
	return ""
}

function normalizeProviderId(providerId: string) {
	const providerMap: Record<string, string> = {
		ANTHROPIC: "anthropic",
		OPENROUTER: "openrouter",
		BEDROCK: "bedrock",
		VERTEX: "vertex",
		OPENAI: "openai",
		OLLAMA: "ollama",
		LMSTUDIO: "lmstudio",
		GEMINI: "gemini",
		OPENAI_NATIVE: "openai-native",
		REQUESTY: "requesty",
		TOGETHER: "together",
		DEEPSEEK: "deepseek",
		QWEN: "qwen",
		QWEN_CODE: "qwen-code",
		DOUBAO: "doubao",
		MISTRAL: "mistral",
		VSCODE_LM: "vscode-lm",
		CLINE: "cline",
		LITELLM: "litellm",
		MOONSHOT: "moonshot",
		HUGGINGFACE: "huggingface",
		NEBIUS: "nebius",
		WANDB: "wandb",
		FIREWORKS: "fireworks",
		ASKSAGE: "asksage",
		XAI: "xai",
		SAMBANOVA: "sambanova",
		CEREBRAS: "cerebras",
		GROQ: "groq",
		BASETEN: "baseten",
		SAPAICORE: "sapaicore",
		CLAUDE_CODE: "claude-code",
		HUAWEI_CLOUD_MAAS: "huawei-cloud-maas",
		VERCEL_AI_GATEWAY: "vercel-ai-gateway",
		ZAI: "zai",
		DIFY: "dify",
		OCA: "oca",
		AIHUBMIX: "aihubmix",
		MINIMAX: "minimax",
		HICAP: "hicap",
		NOUSRESEARCH: "nousResearch",
		OPENAI_CODEX: "openai-codex",
		LIG: "account",
		LIGVS: "account",
		LIG_VS: "account",
		ACCOUNT: "account",
	}
	if (providerMap[providerId]) {
		return providerMap[providerId]
	}
	if (providerId === "openai") {
		return "openai"
	}
	if (providerId === "openai-compatible") {
		return "openai-compatible"
	}
	return providerId
}

function normalizeSdkProviderId(providerId: string) {
	// The upstream webview uses "openai" for the OpenAI Compatible option, while
	// @cline/sdk registers that provider as "openai-compatible".
	if (providerId === "openai") {
		return "openai-compatible"
	}
	return providerId
}

function compactApiConfiguration(apiConfig: Record<string, unknown>) {
	const compact: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(apiConfig)) {
		if (value !== undefined && value !== null) {
			compact[key] = value
		}
	}

	for (const key of ["actModeApiProvider", "planModeApiProvider"]) {
		const value = compact[key]
		const normalized = normalizeProviderValue(value)
		if (normalized) {
			compact[key] = normalized
		}
	}

	return compact
}

function resolveModelId(apiConfig: Record<string, unknown>, providerId: string, modePrefix: string) {
	const providerModelFields: Record<string, string> = {
		anthropic: `${modePrefix}ApiModelId`,
		openrouter: `${modePrefix}OpenRouterModelId`,
		openai: `${modePrefix}OpenAiModelId`,
		"openai-compatible": `${modePrefix}OpenAiModelId`,
		gemini: `${modePrefix}GeminiModelId`,
		ollama: `${modePrefix}OllamaModelId`,
		lmstudio: `${modePrefix}LmStudioModelId`,
		litellm: `${modePrefix}LiteLlmModelId`,
		requesty: `${modePrefix}RequestyModelId`,
		together: `${modePrefix}TogetherModelId`,
		fireworks: `${modePrefix}FireworksModelId`,
		groq: `${modePrefix}GroqModelId`,
		baseten: `${modePrefix}BasetenModelId`,
		huggingface: `${modePrefix}HuggingFaceModelId`,
		"vercel-ai-gateway": `${modePrefix}VercelAiGatewayModelId`,
		aihubmix: `${modePrefix}AihubmixModelId`,
		hicap: `${modePrefix}HicapModelId`,
		oca: `${modePrefix}OcaModelId`,
	}

	const providerSpecific = getString(apiConfig, providerModelFields[providerId])
	if (providerSpecific) {
		return providerSpecific
	}

	if (providerId === "ollama") {
		return ""
	}

	return getString(apiConfig, `${modePrefix}ApiModelId`) || getString(apiConfig, `${modePrefix}OpenAiModelId`)
}

function resolveConfiguredContextWindow(
	apiConfig: Record<string, unknown>,
	providerId: string,
	modePrefix: string,
	modelId: string,
) {
	const providerInfoFields: Record<string, string> = {
		openrouter: `${modePrefix}OpenRouterModelInfo`,
		openai: `${modePrefix}OpenAiModelInfo`,
		"openai-compatible": `${modePrefix}OpenAiModelInfo`,
		aihubmix: `${modePrefix}AihubmixModelInfo`,
		anthropic: `${modePrefix}ApiModelInfo`,
	}
	const explicitModelInfo = asRecord(apiConfig[providerInfoFields[providerId] || `${modePrefix}ApiModelInfo`])
	const explicitContextWindow = positiveIntegerValue(explicitModelInfo.contextWindow) ?? positiveIntegerValue(explicitModelInfo.context_length)
	if (explicitContextWindow && explicitContextWindow > 0) {
		return explicitContextWindow
	}
	if (providerId === "ollama") {
		return positiveIntegerValue(apiConfig.ollamaApiOptionsCtxNum) || positiveIntegerValue(inferModelInfo(modelId, providerId).contextWindow)
	}
	if (providerId === "lmstudio") {
		return positiveIntegerValue(apiConfig.lmStudioMaxTokens) || positiveIntegerValue(inferModelInfo(modelId, providerId).contextWindow)
	}
	return positiveIntegerValue(inferModelInfo(modelId, providerId).contextWindow)
}

function positiveIntegerValue(value: unknown) {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined
}

function resolveApiKey(apiConfig: Record<string, unknown>, providerId: string) {
	for (const field of providerCredentialFields(providerId)) {
		const value = getString(apiConfig, field)
		if (value) {
			return value
		}
	}

	return (
		resolveProviderEnvApiKey(providerId) ||
		(["openai", "openai-compatible", "openai-native"].includes(providerId)
			? getString(apiConfig, "actModeOpenAiApiKey") || getString(apiConfig, "planModeOpenAiApiKey")
			: "")
	)
}

function providerCredentialFields(providerId: string) {
	const apiKeyFields: Record<string, string[]> = {
		cline: ["clineApiKey", "clineAccountId"],
		anthropic: ["apiKey"],
		openrouter: ["openRouterApiKey"],
		bedrock: ["awsBedrockApiKey", "awsAccessKey"],
		openai: ["openAiApiKey"],
		"openai-compatible": ["openAiApiKey"],
		"openai-native": ["openAiNativeApiKey"],
		ollama: ["ollamaApiKey"],
		gemini: ["geminiApiKey"],
		requesty: ["requestyApiKey"],
		together: ["togetherApiKey"],
		fireworks: ["fireworksApiKey"],
		groq: ["groqApiKey"],
		litellm: ["liteLlmApiKey"],
		moonshot: ["moonshotApiKey"],
		nebius: ["nebiusApiKey"],
		deepseek: ["deepSeekApiKey"],
		qwen: ["qwenApiKey"],
		"qwen-code": ["qwenApiKey"],
		doubao: ["doubaoApiKey"],
		mistral: ["mistralApiKey"],
		xai: ["xaiApiKey"],
		zai: ["zaiApiKey"],
		sambanova: ["sambanovaApiKey"],
		cerebras: ["cerebrasApiKey"],
		asksage: ["asksageApiKey"],
		baseten: ["basetenApiKey"],
		huggingface: ["huggingFaceApiKey"],
		"huawei-cloud-maas": ["huaweiCloudMaasApiKey"],
		dify: ["difyApiKey"],
		"vercel-ai-gateway": ["vercelAiGatewayApiKey"],
		minimax: ["minimaxApiKey"],
		aihubmix: ["aihubmixApiKey"],
		hicap: ["hicapApiKey"],
		nousResearch: ["nousResearchApiKey"],
		sapaicore: ["sapAiCoreClientId", "sapAiCoreClientSecret"],
		oca: ["ocaApiKey"],
		wandb: ["wandbApiKey"],
	}
	return apiKeyFields[providerId] || []
}

function providerCredentialField(providerId: string) {
	return providerCredentialFields(providerId)[0] || ""
}

function extractProviderCredentialValue(request: Record<string, unknown>) {
	return (
		getString(request, "apiKey") ||
		getString(request, "token") ||
		getString(request, "accessToken") ||
		getString(request, "credential") ||
		getString(request, "secret") ||
		getString(request, "value")
	)
}

function providerBaseUrlField(providerId: string) {
	const baseUrlFields: Record<string, string> = {
		anthropic: "anthropicBaseUrl",
		bedrock: "awsBedrockEndpoint",
		openai: "openAiBaseUrl",
		"openai-compatible": "openAiBaseUrl",
		"openai-native": "openAiBaseUrl",
		openrouter: "openRouterBaseUrl",
		groq: "groqBaseUrl",
		gemini: "geminiBaseUrl",
		ollama: "ollamaBaseUrl",
		lmstudio: "lmStudioBaseUrl",
		litellm: "liteLlmBaseUrl",
		requesty: "requestyBaseUrl",
		huggingface: "huggingFaceBaseUrl",
		baseten: "basetenBaseUrl",
		"vercel-ai-gateway": "vercelAiGatewayBaseUrl",
		hicap: "hicapBaseUrl",
		asksage: "asksageApiUrl",
		sapaicore: "sapAiCoreBaseUrl",
		dify: "difyBaseUrl",
		oca: "ocaBaseUrl",
		aihubmix: "aihubmixBaseUrl",
	}

	return baseUrlFields[providerId] || ""
}

function resolveBaseUrl(apiConfig: Record<string, unknown>, providerId: string) {
	const field = providerBaseUrlField(providerId)
	const providerSpecific = (field ? getString(apiConfig, field) : "") || resolveProviderEnvBaseUrl(providerId)
	if (providerSpecific) {
		return providerSpecific
	}
	return ["openai", "openai-compatible", "openai-native"].includes(providerId) ? getString(apiConfig, "actModeOpenAiBaseUrl") : ""
}

function resolveProviderEnvApiKey(providerId: string) {
	const envFields: Record<string, string[]> = {
		cline: ["CLINE_API_KEY"],
		anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
		openrouter: ["OPENROUTER_API_KEY"],
		openai: ["OPENAI_API_KEY"],
		"openai-compatible": ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
		"openai-native": ["OPENAI_API_KEY"],
		ollama: ["OLLAMA_API_KEY"],
		gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
		requesty: ["REQUESTY_API_KEY"],
		together: ["TOGETHER_API_KEY"],
		fireworks: ["FIREWORKS_API_KEY"],
		groq: ["GROQ_API_KEY"],
		litellm: ["LITELLM_API_KEY", "LITE_LLM_API_KEY"],
		moonshot: ["MOONSHOT_API_KEY"],
		nebius: ["NEBIUS_API_KEY"],
		deepseek: ["DEEPSEEK_API_KEY", "DEEP_SEEK_API_KEY"],
		qwen: ["QWEN_API_KEY"],
		"qwen-code": ["QWEN_API_KEY"],
		doubao: ["DOUBAO_API_KEY"],
		mistral: ["MISTRAL_API_KEY"],
		xai: ["XAI_API_KEY"],
		zai: ["ZAI_API_KEY"],
		sambanova: ["SAMBANOVA_API_KEY"],
		cerebras: ["CEREBRAS_API_KEY"],
		asksage: ["ASKSAGE_API_KEY"],
		baseten: ["BASETEN_API_KEY"],
		huggingface: ["HUGGINGFACE_API_KEY", "HUGGING_FACE_API_KEY"],
		"huawei-cloud-maas": ["HUAWEI_CLOUD_MAAS_API_KEY"],
		dify: ["DIFY_API_KEY"],
		"vercel-ai-gateway": ["VERCEL_AI_GATEWAY_API_KEY"],
		minimax: ["MINIMAX_API_KEY"],
		aihubmix: ["AIHUBMIX_API_KEY"],
		hicap: ["HICAP_API_KEY"],
		nousResearch: ["NOUSRESEARCH_API_KEY", "NOUS_RESEARCH_API_KEY"],
		oca: ["OCA_API_KEY"],
		wandb: ["WANDB_API_KEY"],
	}
	for (const name of envFields[providerId] || []) {
		const value = process.env[name]
		if (value) {
			return value
		}
	}
	return ""
}

function resolveProviderEnvBaseUrl(providerId: string) {
	const envFields: Record<string, string[]> = {
		anthropic: ["ANTHROPIC_BASE_URL"],
		bedrock: ["AWS_BEDROCK_ENDPOINT"],
		openai: ["OPENAI_BASE_URL"],
		"openai-compatible": ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"],
		"openai-native": ["OPENAI_BASE_URL"],
		openrouter: ["OPENROUTER_BASE_URL"],
		groq: ["GROQ_BASE_URL"],
		gemini: ["GEMINI_BASE_URL"],
		ollama: ["OLLAMA_BASE_URL"],
		lmstudio: ["LMSTUDIO_BASE_URL", "LM_STUDIO_BASE_URL"],
		litellm: ["LITELLM_BASE_URL", "LITE_LLM_BASE_URL"],
		requesty: ["REQUESTY_BASE_URL"],
		huggingface: ["HUGGINGFACE_BASE_URL", "HUGGING_FACE_BASE_URL"],
		baseten: ["BASETEN_BASE_URL"],
		"vercel-ai-gateway": ["VERCEL_AI_GATEWAY_BASE_URL"],
		hicap: ["HICAP_BASE_URL"],
		asksage: ["ASKSAGE_API_URL"],
		sapaicore: ["SAP_AICORE_BASE_URL"],
		dify: ["DIFY_BASE_URL"],
		oca: ["OCA_BASE_URL"],
		aihubmix: ["AIHUBMIX_BASE_URL"],
	}
	for (const name of envFields[providerId] || []) {
		const value = process.env[name]
		if (value) {
			return value
		}
	}
	return ""
}

function pickApiConfigurationFields(request: Record<string, unknown>) {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(request)) {
		if (
			key === "apiProvider" ||
			key.endsWith("ApiProvider") ||
			key.endsWith("ModelId") ||
			key.endsWith("ApiKey") ||
			key.endsWith("BaseUrl") ||
			key.endsWith("OAuthCredentials") ||
			key.endsWith("ModelInfo") ||
			key.endsWith("ReasoningEffort") ||
			key.endsWith("ThinkingBudgetTokens") ||
			key === "openAiBaseUrl" ||
			key === "anthropicBaseUrl" ||
			key === "geminiBaseUrl" ||
			key === "requestTimeoutMs" ||
			key === "ollamaApiOptionsCtxNum" ||
			key === "lmStudioMaxTokens" ||
			key === "fireworksModelMaxTokens" ||
			key === "fireworksModelMaxCompletionTokens"
		) {
			result[key] = value
		}
	}

	const apiProvider = normalizeProviderValue(result.apiProvider)
	if (apiProvider) {
		result.actModeApiProvider = apiProvider
		result.planModeApiProvider = apiProvider
		delete result.apiProvider
	}

	return result
}

function extractApiConfigurationUpdate(request: Record<string, unknown>) {
	const direct = [
		request.apiConfiguration,
		request.api_configuration,
		request.configuration,
		request.config,
		request.value,
	]

	for (const candidate of direct) {
		const record = asRecord(candidate)
		const picked = pickApiConfigurationFields(record)
		if (Object.keys(picked).length > 0) {
			return picked
		}
	}

	return pickApiConfigurationFields(request)
}

function normalizeApiConfiguration(apiConfig: Record<string, unknown>) {
	const normalized = compactApiConfiguration(apiConfig)
	const provider = getString(normalized, "actModeApiProvider") || getString(normalized, "planModeApiProvider")
	if (provider) {
		normalized.actModeApiProvider = provider
		normalized.planModeApiProvider = getString(normalized, "planModeApiProvider") || provider
	}

	const openAiModel = getString(normalized, "openAiModelId")
	if (openAiModel) {
		normalized.actModeOpenAiModelId = getString(normalized, "actModeOpenAiModelId") || openAiModel
		normalized.planModeOpenAiModelId = getString(normalized, "planModeOpenAiModelId") || openAiModel
	}

	const openAiApiKey = getString(normalized, "openAiApiKey")
	if (openAiApiKey) {
		normalized.actModeOpenAiApiKey = getString(normalized, "actModeOpenAiApiKey") || openAiApiKey
		normalized.planModeOpenAiApiKey = getString(normalized, "planModeOpenAiApiKey") || openAiApiKey
	}

	const openAiBaseUrl = getString(normalized, "openAiBaseUrl")
	if (openAiBaseUrl) {
		normalized.actModeOpenAiBaseUrl = getString(normalized, "actModeOpenAiBaseUrl") || openAiBaseUrl
		normalized.planModeOpenAiBaseUrl = getString(normalized, "planModeOpenAiBaseUrl") || openAiBaseUrl
	}

	return normalized
}

function normalizeApiConfigurationProfiles(
	value: unknown,
	fallbackApiConfiguration: unknown,
	fallbackPlanActSeparateModelsSetting: boolean,
) {
	const now = new Date().toISOString()
	const fallbackProfile = {
		id: "default",
		name: "Default",
		apiConfiguration: normalizeApiConfiguration(asRecord(fallbackApiConfiguration)),
		planActSeparateModelsSetting: fallbackPlanActSeparateModelsSetting,
		createdAt: now,
		updatedAt: now,
	}

	const profiles = arrayOfRecords(value)
		.map((profile, index) => {
			const apiConfiguration = normalizeApiConfiguration(asRecord(profile.apiConfiguration))
			if (Object.keys(apiConfiguration).length === 0) {
				return null
			}
			const id = getString(profile, "id") || `profile-${index + 1}`
			return {
				id,
				name: getString(profile, "name") || (index === 0 ? "Default" : `Profile ${index + 1}`),
				apiConfiguration,
				planActSeparateModelsSetting:
					typeof profile.planActSeparateModelsSetting === "boolean"
						? profile.planActSeparateModelsSetting
						: fallbackPlanActSeparateModelsSetting,
				createdAt: getString(profile, "createdAt") || now,
				updatedAt: getString(profile, "updatedAt") || now,
			}
		})
		.filter((profile): profile is typeof fallbackProfile => Boolean(profile))

	return profiles.length > 0 ? profiles : [fallbackProfile]
}

function normalizePreferredLanguage(value: string) {
	const normalized = value.trim().toLowerCase()
	return normalized === "korean" || normalized === "korean - 한국어" || normalized === "한국어"
		? "Korean - 한국어"
		: "English"
}

function resolveOAuthCredentials(apiConfig: Record<string, unknown>, providerId: string) {
	const field = oauthCredentialsField(providerId)
	const raw = getString(apiConfig, field)
	if (!raw) {
		return {}
	}

	const parsed = asRecord(tryParseJson(raw) ?? {})
	return Object.keys(parsed).length > 0 ? parsed : { accessToken: raw }
}

function describeOAuthCredentialState(credentials: Record<string, unknown>) {
	const expiresAt = numberValue(credentials.expiresAt) || numberValue(credentials.expires_at)
	const refreshToken = getString(credentials, "refreshToken") || getString(credentials, "refresh_token")
	if (!Object.keys(credentials).length) {
		return { refreshStatus: "none", refreshSupported: false, expiresAt: undefined as number | undefined }
	}
	if (!expiresAt) {
		return { refreshStatus: refreshToken ? "refreshable" : "unknown", refreshSupported: Boolean(refreshToken), expiresAt: undefined as number | undefined }
	}
	const skewMs = readPositiveIntEnv("VSCLINE_OAUTH_EXPIRY_SKEW_MS", 60_000)
	const refreshStatus = expiresAt <= Date.now() + skewMs ? "expired" : refreshToken ? "refreshable" : "valid"
	return { refreshStatus, refreshSupported: Boolean(refreshToken), expiresAt }
}

async function refreshOAuthToken(provider: string, refreshToken: string, exchange: OAuthTokenExchangeConfig) {
	const body = new URLSearchParams()
	body.set("grant_type", "refresh_token")
	body.set("refresh_token", refreshToken)
	body.set("client_id", exchange.clientId)
	if (exchange.clientSecret && exchange.authMethod !== "client_secret_basic") {
		body.set("client_secret", exchange.clientSecret)
	}
	if (exchange.scope) {
		body.set("scope", exchange.scope)
	}
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	}
	if (exchange.clientSecret && exchange.authMethod === "client_secret_basic") {
		headers.authorization = `Basic ${Buffer.from(`${exchange.clientId}:${exchange.clientSecret}`).toString("base64")}`
	}
	const response = await fetch(exchange.tokenUrl, { method: "POST", headers, body })
	const text = await response.text()
	const parsed = asRecord(tryParseJson(text) ?? {})
	if (!response.ok) {
		const error = getString(parsed, "error_description") || getString(parsed, "error") || truncateText(text, 500)
		throw new Error(`Token refresh for ${providerAuthLabel(provider)} returned HTTP ${response.status}: ${error || response.statusText}`)
	}
	const accessToken = getString(parsed, "access_token") || getString(parsed, "token")
	if (!accessToken) {
		throw new Error(`Token refresh for ${providerAuthLabel(provider)} did not include access_token.`)
	}
	const expiresIn = getNumber(parsed, "expires_in")
	return {
		accessToken,
		refreshToken: getString(parsed, "refresh_token") || refreshToken,
		tokenType: getString(parsed, "token_type") || undefined,
		expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
		tokenResponse: parsed,
	}
}

function extractAutoApprovalSettingsUpdate(request: Record<string, unknown>) {
	const candidates = [
		request.autoApprovalSettings,
		request.settings,
		request.value,
		request.state,
		request.autoApproval,
	]

	for (const candidate of candidates) {
		const record = asRecord(candidate)
		if (isAutoApprovalSettingsLike(record)) {
			return record
		}
	}

	if (isAutoApprovalSettingsLike(request)) {
		return request
	}

	const actionKeys = [
		"readFiles",
		"readFilesExternally",
		"editFiles",
		"editFilesExternally",
		"executeSafeCommands",
		"executeAllCommands",
		"useBrowser",
		"useMcp",
		"useMcpServers",
	]
	const actions: Record<string, unknown> = {}
	for (const key of actionKeys) {
		if (key in request) {
			actions[key] = request[key]
		}
	}
	return Object.keys(actions).length > 0 ? { actions } : {}
}

function isAutoApprovalSettingsLike(record: Record<string, unknown>) {
	return "actions" in record || "enabled" in record || "maxRequests" in record || "favorites" in record
}

function createToolPolicies(autoApprovalSettings: unknown, browserSettings: unknown = {}, mode: unknown = "act") {
	const settings = asRecord(autoApprovalSettings)
	const actions = asRecord(settings.actions)
	const autoApproveAll = settings.enabled === true
	const webFetchEnabled = isWebFetchEnabled(browserSettings)
	const readAuto = autoApproveAll && actions.readFiles === true
	const editAuto = autoApproveAll && actions.editFiles === true
	const commandAuto = autoApproveAll && (actions.executeAllCommands === true || actions.executeSafeCommands === true)
	const mcpAuto = autoApproveAll && (actions.useMcp === true || actions.useMcpServers === true)

	const policy = {
		readFile: { enabled: true, autoApprove: readAuto },
		read_file: { enabled: true, autoApprove: readAuto },
		read: { enabled: true, autoApprove: readAuto },
		read_files: { enabled: true, autoApprove: readAuto },
		search: { enabled: true, autoApprove: readAuto },
		grep: { enabled: true, autoApprove: readAuto },
		glob: { enabled: true, autoApprove: readAuto },
		searchFiles: { enabled: true, autoApprove: readAuto },
		search_files: { enabled: true, autoApprove: readAuto },
		search_codebase: { enabled: true, autoApprove: readAuto },
		editor: { enabled: true, autoApprove: editAuto },
		edit: { enabled: true, autoApprove: editAuto },
		applyPatch: { enabled: true, autoApprove: editAuto },
		apply_patch: { enabled: true, autoApprove: editAuto },
		bash: { enabled: true, autoApprove: commandAuto },
		executeCommand: { enabled: true, autoApprove: commandAuto },
		execute_command: { enabled: true, autoApprove: commandAuto },
		runCommand: { enabled: true, autoApprove: commandAuto },
		run_command: { enabled: true, autoApprove: commandAuto },
		run_commands: { enabled: true, autoApprove: commandAuto },
		fetch_web_content: { enabled: webFetchEnabled, autoApprove: false },
		skills: { enabled: false, autoApprove: false },
		useMcpServer: { enabled: true, autoApprove: mcpAuto },
		use_mcp_server: { enabled: true, autoApprove: mcpAuto },
		ask_question: { enabled: true, autoApprove: true },
		submit_and_exit: { enabled: true, autoApprove: true },
	}
	if (mode === "plan") {
		const blockedTools: string[] = []
		for (const key of Object.keys(policy) as Array<keyof typeof policy>) {
			if (isPlanModeBlockedTool(key)) {
				policy[key] = { enabled: false, autoApprove: false }
				blockedTools.push(String(key))
			}
		}
		logInteraction("sidecar", "sdkModePolicy.plan", { blockedTools })
	}
	return policy
}

function isPlanModeBlockedTool(toolName: string) {
	const mapped = mapToolName(toolName)
	return mapped === "executeCommand" ||
		mapped === "editedExistingFile" ||
		mapped === "useMcpServer" ||
		mapped === "fetch_web_content" ||
		mapped === "browser_action_launch" ||
		mapped === "browser" ||
		mapped === "skills"
}

function resolveRequestedPlanActMode(message: unknown, currentMode: string) {
	const record = asRecord(message)
	const raw = String(record.mode ?? record.value ?? "").toLowerCase()
	if (raw === "plan" || raw === "planactmode.plan" || raw === "0") {
		return "plan"
	}
	if (raw === "act" || raw === "planactmode.act" || raw === "1") {
		return "act"
	}
	return currentMode === "plan" ? "act" : "plan"
}

function isWebFetchEnabled(browserSettings: unknown) {
	const settings = asRecord(browserSettings)
	return process.env.VSCLINE_ENABLE_WEB_FETCH === "1" && settings.disableToolUse !== true
}

function webFetchDisabledReason(browserSettings: unknown) {
	if (process.env.VSCLINE_ENABLE_WEB_FETCH !== "1") {
		return "VSCLINE_ENABLE_WEB_FETCH is not set to 1."
	}
	if (asRecord(browserSettings).disableToolUse === true) {
		return "Browser/web tool usage is disabled in settings."
	}
	return ""
}

function isRuntimeSettingsKey(key: string) {
	return (
		key === "mode" ||
		key === "planActSeparateModelsSetting" ||
		key === "preferredLanguage" ||
		key === "subagentsEnabled" ||
		key === "scheduledAgentsEnabled" ||
		key === "hooksEnabled" ||
		key === "enableCheckpointsSetting" ||
		key === "yoloModeToggled" ||
		key === "doubleCheckCompletionEnabled" ||
		key === "enableParallelToolCalling" ||
		key === "nativeToolCallEnabled" ||
		key === "strictPlanModeEnabled" ||
		key === "useAutoCondense" ||
		key === "customPrompt"
	)
}

function cloneTaskSnapshot(snapshot: unknown): { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null {
	const record = asRecord(snapshot)
	const taskItem = asRecord(record.taskItem)
	if (Object.keys(taskItem).length === 0) {
		return null
	}
	return {
		taskItem: { ...taskItem },
		messages: arrayOfRecords(record.messages).map(normalizeClineMessagePayload),
	}
}

function loadInitialState() {
	const state = createInitialState()
	const persisted = readPersistedState()
	if (!persisted) {
		return state
	}

	const apiConfiguration = asRecord(persisted.apiConfiguration)
	if (Object.keys(apiConfiguration).length > 0) {
		state.apiConfiguration = normalizeApiConfiguration({
			...state.apiConfiguration,
			...apiConfiguration,
		}) as typeof state.apiConfiguration
		if (Object.keys(resolveOAuthCredentials(state.apiConfiguration, "openai-codex")).length > 0) {
			state.openAiCodexIsAuthenticated = true
		}
	}

	state.apiConfigurationProfiles = normalizeApiConfigurationProfiles(
		persisted.apiConfigurationProfiles,
		state.apiConfiguration,
		state.planActSeparateModelsSetting,
	) as typeof state.apiConfigurationProfiles
	state.activeApiConfigurationProfileId =
		getString(persisted, "activeApiConfigurationProfileId") ||
		getString(state.apiConfigurationProfiles[0], "id")
	const activeProfile = arrayOfRecords(state.apiConfigurationProfiles).find(
		(profile) => getString(profile, "id") === state.activeApiConfigurationProfileId,
	)
	if (activeProfile) {
		state.apiConfiguration = normalizeApiConfiguration(asRecord(activeProfile.apiConfiguration)) as typeof state.apiConfiguration
		if (typeof activeProfile.planActSeparateModelsSetting === "boolean") {
			state.planActSeparateModelsSetting = activeProfile.planActSeparateModelsSetting
		}
	}

	const autoApprovalSettings = asRecord(persisted.autoApprovalSettings)
	if (Object.keys(autoApprovalSettings).length > 0) {
		state.autoApprovalSettings = {
			...state.autoApprovalSettings,
			...autoApprovalSettings,
			actions: {
				...asRecord(state.autoApprovalSettings.actions),
				...asRecord(autoApprovalSettings.actions),
			},
		}
	}

	const browserSettings = asRecord(persisted.browserSettings)
	if (Object.keys(browserSettings).length > 0) {
		state.browserSettings = {
			...asRecord(state.browserSettings),
			...browserSettings,
		} as typeof state.browserSettings
		const enabled = isWebFetchEnabled(state.browserSettings)
		state.clineWebToolsEnabled = {
			user: enabled,
			featureFlag: enabled,
			reason: webFetchDisabledReason(state.browserSettings) || undefined,
		}
	}

	if (persisted.mode === "plan" || persisted.mode === "act") {
		state.mode = persisted.mode
	}
	if (typeof persisted.planActSeparateModelsSetting === "boolean") {
		state.planActSeparateModelsSetting = persisted.planActSeparateModelsSetting
	}
	for (const key of [
		"enableCheckpointsSetting",
		"mcpResponsesCollapsed",
		"strictPlanModeEnabled",
		"yoloModeToggled",
		"useAutoCondense",
		"subagentsEnabled",
		"scheduledAgentsEnabled",
		"backgroundEditEnabled",
		"doubleCheckCompletionEnabled",
		"lazyTeammateModeEnabled",
		"showFeatureTips",
		"hooksEnabled",
		"enableParallelToolCalling",
	] as const) {
		if (typeof persisted[key] === "boolean") {
			state[key] = persisted[key] as never
		}
	}
	if (typeof persisted.nativeToolCallSetting === "boolean") {
		state.nativeToolCallSetting = persisted.nativeToolCallSetting
	}
	if (typeof persisted.mcpDisplayMode === "string") {
		state.mcpDisplayMode = normalizeMcpDisplayMode(persisted.mcpDisplayMode, state.mcpDisplayMode)
	}
	if (persisted.uiLanguage === "en" || persisted.uiLanguage === "ko") {
		state.uiLanguage = persisted.uiLanguage
	} else if (getString(persisted, "preferredLanguage") === "English") {
		state.uiLanguage = "en"
	}
	if (typeof persisted.preferredLanguage === "string") {
		state.preferredLanguage = normalizePreferredLanguage(persisted.preferredLanguage)
	}
	const customPrompt = getString(persisted, "customPrompt")
	state.customPrompt = customPrompt === "compact" ? "" : customPrompt
	if (arrayOfRecords(persisted.apiConfigurationProfiles).length === 0) {
		state.apiConfigurationProfiles = normalizeApiConfigurationProfiles(
			[],
			state.apiConfiguration,
			state.planActSeparateModelsSetting,
		) as typeof state.apiConfigurationProfiles
		state.activeApiConfigurationProfileId = getString(state.apiConfigurationProfiles[0], "id")
	} else {
		const profileAfterSettings = arrayOfRecords(state.apiConfigurationProfiles).find(
			(profile) => getString(profile, "id") === state.activeApiConfigurationProfileId,
		)
		if (profileAfterSettings && typeof profileAfterSettings.planActSeparateModelsSetting === "boolean") {
			state.planActSeparateModelsSetting = profileAfterSettings.planActSeparateModelsSetting
		}
	}

	const taskHistory = arrayOfRecords(persisted.taskHistory)
	if (taskHistory.length > 0) {
		state.taskHistory = taskHistory
	}

	const taskSnapshots = asRecord(persisted.taskSnapshots)
	for (const [taskId, snapshot] of Object.entries(taskSnapshots)) {
		const normalized = cloneTaskSnapshot(snapshot)
		if (taskId && normalized) {
			state.taskSnapshots[taskId] = normalized
		}
	}

	const currentTaskItem = asRecord(persisted.currentTaskItem)
	if (Object.keys(currentTaskItem).length > 0) {
		state.currentTaskItem = currentTaskItem
		state.clineMessages = arrayOfRecords(persisted.clineMessages).map(normalizeClineMessagePayload)
	}

	return state
}

function readPersistedState() {
	try {
		return JSON.parse(fs.readFileSync(getSettingsPath(), "utf8")) as Record<string, unknown>
	} catch {
		return null
	}
}

function savePersistedState(state: ReturnType<typeof createInitialState>) {
	try {
		const settingsPath = getSettingsPath()
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
		fs.writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					apiConfiguration: state.apiConfiguration,
					apiConfigurationProfiles: state.apiConfigurationProfiles,
					activeApiConfigurationProfileId: state.activeApiConfigurationProfileId,
					autoApprovalSettings: state.autoApprovalSettings,
					browserSettings: state.browserSettings,
					uiLanguage: state.uiLanguage,
					preferredLanguage: state.preferredLanguage,
					customPrompt: state.customPrompt,
					mode: state.mode,
					planActSeparateModelsSetting: state.planActSeparateModelsSetting,
					enableCheckpointsSetting: state.enableCheckpointsSetting,
					mcpDisplayMode: state.mcpDisplayMode,
					mcpResponsesCollapsed: state.mcpResponsesCollapsed,
					strictPlanModeEnabled: state.strictPlanModeEnabled,
					yoloModeToggled: state.yoloModeToggled,
					useAutoCondense: state.useAutoCondense,
					subagentsEnabled: state.subagentsEnabled,
					scheduledAgentsEnabled: state.scheduledAgentsEnabled,
					backgroundEditEnabled: state.backgroundEditEnabled,
					doubleCheckCompletionEnabled: state.doubleCheckCompletionEnabled,
					lazyTeammateModeEnabled: state.lazyTeammateModeEnabled,
					showFeatureTips: state.showFeatureTips,
					hooksEnabled: state.hooksEnabled,
					nativeToolCallSetting: state.nativeToolCallSetting,
					enableParallelToolCalling: state.enableParallelToolCalling,
					taskHistory: state.taskHistory,
					taskSnapshots: state.taskSnapshots,
					currentTaskItem: state.currentTaskItem,
					clineMessages: state.currentTaskItem ? state.clineMessages : [],
				},
				null,
				2,
			),
			"utf8",
		)
	} catch (error) {
		console.error("Failed to persist LIG VS settings:", error)
	}
}

function clearPersistedState() {
	try {
		fs.rmSync(getSettingsPath(), { force: true })
	} catch {
		// Ignore cleanup failures; reset still applies to the in-memory state.
	}
}

function createMcpServersLazyResponse() {
	return {
		mcpServers: [],
		reduced: true,
		reason: "mcp_servers_lazy_loaded",
		message: "MCP servers are loaded when the MCP view is opened.",
	}
}

function getSettingsPath() {
	return path.join(getSettingsRoot(), "settings.json")
}

function getSettingsRoot() {
	const configured = process.env.VSCLINE_SETTINGS_DIR
	if (isUsableDirectory(configured)) {
		return path.resolve(configured)
	}

	const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
	if (isUsableDirectory(localAppData)) {
		return path.join(path.resolve(localAppData), "VsClineAgent")
	}

	const home = getUsableHomeDirectory()
	return path.join(home, "AppData", "Local", "VsClineAgent")
}

function getUsableHomeDirectory() {
	const candidates = [process.env.USERPROFILE, process.env.HOME, os.homedir(), getFallbackHomeDirectory()]
	for (const candidate of candidates) {
		if (isUsableDirectory(candidate)) {
			return path.resolve(candidate)
		}
	}
	return getFallbackHomeDirectory()
}

function getFallbackHomeDirectory() {
	const root = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir()
	const fallbackHome = path.join(root, "VsClineAgent", "home")
	try {
		fs.mkdirSync(fallbackHome, { recursive: true })
		return fallbackHome
	} catch {
		return os.tmpdir()
	}
}

function isUsableDirectory(value: string | undefined): value is string {
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

function getSidecarDataPath(fileName: string) {
	return path.join(path.dirname(getSettingsPath()), fileName)
}

function getScheduledAgentsDirectory(workspaceRoot: string) {
	return workspaceRoot ? path.join(workspaceRoot, ".cline", "cron") : ""
}

function readScheduledAgentSpecs(workspaceRoot: string) {
	const directory = getScheduledAgentsDirectory(workspaceRoot)
	return safeReadDirFiles(directory)
		.filter((filePath) => [".json", ".md", ".yaml", ".yml"].includes(path.extname(filePath).toLowerCase()))
		.map((filePath) => scheduledSpecFromFile(filePath, workspaceRoot))
		.filter((spec) => Boolean(spec))
		.map((spec) => asRecord(spec))
}

function scheduledSpecFromFile(filePath: string, workspaceRoot: string) {
	try {
		const raw = fs.readFileSync(filePath, "utf8")
		const extension = path.extname(filePath).toLowerCase()
		const parsed = extension === ".json" ? asRecord(tryParseJson(raw) ?? {}) : parseLooseKeyValueSpec(raw)
		const id = getString(parsed, "id") || path.basename(filePath, extension)
		const prompt = getString(parsed, "prompt") || getString(parsed, "task") || markdownBodyAfterFrontMatter(raw)
		return {
			id,
			name: getString(parsed, "name") || id,
			description: getString(parsed, "description"),
			schedule: getString(parsed, "schedule") || getString(parsed, "cron"),
			prompt,
			enabled: parsed.enabled !== false,
			source: "local",
			workspaceRoot,
			filePath,
			fileName: path.basename(filePath),
			updatedAt: fs.statSync(filePath).mtimeMs,
		}
	} catch {
		return null
	}
}

function writeScheduledAgentSpec(workspaceRoot: string, request: Record<string, unknown>) {
	const directory = getScheduledAgentsDirectory(workspaceRoot)
	fs.mkdirSync(directory, { recursive: true })
	const specId = safeFileStem(getScheduledSpecId(request) || "scheduled-agent")
	const filePath = path.join(directory, `${specId}.json`)
	const existing = fs.existsSync(filePath) ? asRecord(tryParseJson(fs.readFileSync(filePath, "utf8")) ?? {}) : {}
	const spec = {
		...existing,
		id: specId,
		name: getString(request, "name") || getString(existing, "name") || specId,
		description: getString(request, "description") || getString(existing, "description"),
		schedule: getString(request, "schedule") || getString(request, "cron") || getString(existing, "schedule"),
		prompt: getString(request, "prompt") || getString(request, "task") || getString(request, "text") || getString(existing, "prompt"),
		enabled: request.enabled === undefined ? existing.enabled !== false : request.enabled !== false,
		updatedAt: new Date().toISOString(),
	}
	fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), "utf8")
	return scheduledSpecFromFile(filePath, workspaceRoot) || { ...spec, filePath }
}

function deleteScheduledAgentSpecFile(workspaceRoot: string, specId: string) {
	const directory = getScheduledAgentsDirectory(workspaceRoot)
	const filePath = path.resolve(directory, `${safeFileStem(specId)}.json`)
	if (!filePath.toLowerCase().startsWith(path.resolve(directory).toLowerCase() + path.sep)) {
		throw new Error("Scheduled agent spec path must stay inside .cline/cron.")
	}
	if (!fs.existsSync(filePath)) {
		return false
	}
	fs.rmSync(filePath, { force: true })
	return true
}

function getScheduledSpecId(request: Record<string, unknown>) {
	return safeFileStem(getString(request, "id") || getString(request, "specId") || getString(request, "name") || getString(request, "fileName"))
}

function readScheduledAgentRuns() {
	try {
		const value = tryParseJson(fs.readFileSync(getSidecarDataPath("scheduled-runs.json"), "utf8"))
		return Array.isArray(value) ? value.map(asRecord).slice(0, 25) : []
	} catch {
		return []
	}
}

function appendScheduledAgentRun(run: Record<string, unknown>) {
	const entry = { runId: `scheduled-${createId()}`, ...run }
	const runs = [entry, ...readScheduledAgentRuns()].slice(0, 25)
	fs.mkdirSync(path.dirname(getSidecarDataPath("scheduled-runs.json")), { recursive: true })
	fs.writeFileSync(getSidecarDataPath("scheduled-runs.json"), JSON.stringify(runs, null, 2), "utf8")
	return entry
}

function discoverLocalPlugins(workspaceRoot: string) {
	const candidates = [
		workspaceRoot ? path.join(workspaceRoot, ".cline", "plugins") : "",
		workspaceRoot ? path.join(workspaceRoot, ".cline", "plugins.json") : "",
		path.join(path.dirname(getSettingsPath()), "plugins"),
		path.join(getUsableHomeDirectory(), ".cline", "plugins"),
	].filter(Boolean)
	const plugins: Record<string, unknown>[] = []
	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) {
				continue
			}
			const stat = fs.statSync(candidate)
			if (stat.isFile()) {
				plugins.push(...pluginsFromConfigFile(candidate))
			} else if (stat.isDirectory()) {
				for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
					const pluginRoot = path.join(candidate, entry.name)
					const manifest = entry.isDirectory() ? path.join(pluginRoot, ".codex-plugin", "plugin.json") : pluginRoot
					if (entry.isDirectory() && fs.existsSync(manifest)) {
						plugins.push(pluginFromManifest(manifest, pluginRoot))
					}
				}
			}
		} catch {
			plugins.push({ path: candidate, status: "error", local: true })
		}
	}
	return plugins
}

function pluginsFromConfigFile(filePath: string) {
	const parsed = tryParseJson(fs.readFileSync(filePath, "utf8"))
	const configured = asRecord(parsed).plugins
	const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(configured) ? configured : []
	return list.map((item) => {
		const record = asRecord(item)
		return {
			id: getString(record, "id") || getString(record, "name") || getString(record, "path"),
			name: getString(record, "name") || getString(record, "id"),
			path: getString(record, "path"),
			enabled: record.enabled !== false,
			source: filePath,
			local: true,
			status: "configured",
		}
	})
}

function pluginFromManifest(manifestPath: string, pluginRoot: string) {
	const manifest = asRecord(tryParseJson(fs.readFileSync(manifestPath, "utf8")) ?? {})
	return {
		id: getString(manifest, "id") || path.basename(pluginRoot),
		name: getString(manifest, "name") || getString(manifest, "id") || path.basename(pluginRoot),
		version: getString(manifest, "version"),
		description: getString(manifest, "description"),
		path: pluginRoot,
		manifestPath,
		enabled: manifest.enabled !== false,
		local: true,
		status: "discovered",
	}
}

function parseLooseKeyValueSpec(text: string) {
	const result: Record<string, unknown> = {}
	const frontMatter = text.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/)
	const source = frontMatter?.[1] || text
	for (const line of source.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/)
		if (match) {
			result[match[1]] = match[2].replace(/^["']|["']$/g, "")
		}
	}
	return result
}

function markdownBodyAfterFrontMatter(text: string) {
	return text.replace(/^---\s*[\r\n]+[\s\S]*?[\r\n]+---\s*/, "").trim()
}

function safeFileStem(value: string) {
	return String(value || "")
		.trim()
		.replace(/\.[^.]+$/, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
}

function normalizeOllamaRootBaseUrl(baseUrl: string) {
	return (baseUrl || "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/i, "")
}

function normalizeOllamaOpenAiBaseUrl(baseUrl: string) {
	return `${normalizeOllamaRootBaseUrl(baseUrl)}/v1`
}

function normalizeOpenAiCompatibleBaseUrl(baseUrl: string) {
	const normalized = (baseUrl || "").replace(/\/+$/, "")
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`
}

function isOpenAiCompatibleCatalogProvider(providerId: string) {
	return [
		"openai",
		"openai-compatible",
		"openai-native",
		"lmstudio",
		"litellm",
		"openrouter",
		"requesty",
		"groq",
		"vercel-ai-gateway",
		"huggingface",
		"baseten",
		"aihubmix",
		"hicap",
		"oca",
		"sapaicore",
	].includes(providerId)
}

function defaultOpenAiCompatibleCatalogBaseUrl(providerId: string, apiKey: string) {
	if (!apiKey) {
		return ""
	}

	const defaults: Record<string, string> = {
		openrouter: "https://openrouter.ai/api/v1",
		requesty: "https://router.requesty.ai/v1",
		groq: "https://api.groq.com/openai/v1",
		"vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1",
	}
	return defaults[providerId] || ""
}

function createModelCatalog(
	ids: string[],
	options: {
		providerId?: string
		selectedId?: string
		source?: string
		supported?: boolean
		reduced?: boolean
		message?: string
		error?: string
		modelInfoById?: Record<string, Record<string, unknown>>
		diagnostics?: Record<string, unknown>
	} = {},
) {
	const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)))
	const values = uniqueIds.map((id) => {
		const inferred = inferModelInfo(id, options.providerId || "")
		const remote = options.modelInfoById?.[id] || {}
		return {
			id,
			name: getString(remote, "name") || id,
			...inferred,
			...remote,
			capabilities: modelCapabilities({ ...inferred, ...remote }),
			providerId: options.providerId || undefined,
		}
	})
	const models = values.reduce<Record<string, (typeof values)[number]>>((acc, model) => {
		acc[model.id] = model
		return acc
	}, {})

	return {
		models,
		values,
		items: values,
		modelIds: uniqueIds,
		selectedId: options.selectedId || uniqueIds[0] || "",
		providerId: options.providerId || "",
		source: options.source || "",
		supported: options.supported !== false,
		reduced: options.reduced === true,
		message: options.message || "",
		error: options.error || "",
		diagnostics: options.diagnostics || {},
	}
}

function createCatalogDiagnostics(providerId: string, source: string, details: Record<string, unknown>) {
	return {
		providerId,
		source,
		capabilitySource: "sdk/provider metadata first, endpoint metadata second, conservative inference last",
		airGap: true,
		...details,
		refreshedAt: Date.now(),
	}
}

function inferModelInfo(id: string, providerId: string): Record<string, unknown> {
	const normalizedId = id.toLowerCase()
	const isClaude = normalizedId.includes("claude")
	const isGemini = normalizedId.includes("gemini")
	const isReasoning =
		/(^|[-/:.])(o[134]|o4-mini|o3-mini|reasoning|r1|qwq|gpt-oss|deepseek-r1)([-/:.]|$)/.test(normalizedId) ||
		normalizedId.includes("thinking")
	const supportsImages =
		isGemini ||
		isClaude ||
		normalizedId.includes("vision") ||
		normalizedId.includes("vl") ||
		normalizedId.includes("gpt-4o") ||
		normalizedId.includes("gpt-4.1")
	const contextWindow = inferContextWindow(normalizedId, providerId)
	const supportsPromptCache = isClaude || isGemini || normalizedId.includes("cache")

	return {
		contextWindow,
		maxTokens: inferMaxTokens(normalizedId, contextWindow),
		supportsImages,
		supportsPromptCache,
		supportsReasoning: isReasoning,
		supportsTools: true,
		supportsStreaming: true,
		description: `Model metadata inferred from provider catalog for ${id}.`,
	}
}

function inferContextWindow(normalizedId: string, providerId: string) {
	if (normalizedId.includes("1m") || normalizedId.includes("1-million")) {
		return 1_000_000
	}
	if (normalizedId.includes("gemini-1.5-pro") || normalizedId.includes("gemini-2")) {
		return 1_000_000
	}
	if (normalizedId.includes("claude")) {
		return 200_000
	}
	if (normalizedId.includes("gpt-4.1") || normalizedId.includes("gpt-4o") || normalizedId.includes("o3") || normalizedId.includes("o4")) {
		return 128_000
	}
	if (normalizedId.includes("llama-3.1") || normalizedId.includes("llama-3.3")) {
		return 128_000
	}
	if (providerId === "groq") {
		return 131_072
	}
	return 128_000
}

function inferMaxTokens(normalizedId: string, contextWindow: number) {
	if (normalizedId.includes("claude")) {
		return Math.min(contextWindow, 64_000)
	}
	if (normalizedId.includes("gemini")) {
		return Math.min(contextWindow, 65_536)
	}
	if (normalizedId.includes("o3") || normalizedId.includes("o4") || normalizedId.includes("gpt-4.1")) {
		return Math.min(contextWindow, 32_768)
	}
	return Math.min(contextWindow, 16_384)
}

function modelCapabilities(modelInfo: Record<string, unknown>) {
	return [
		booleanField(modelInfo, "supportsTools") !== false ? "tools" : "",
		booleanField(modelInfo, "supportsReasoning") ? "reasoning" : "",
		booleanField(modelInfo, "supportsImages") ? "images" : "",
		booleanField(modelInfo, "supportsPromptCache") ? "prompt-cache" : "",
	].filter(Boolean)
}

function booleanField(record: Record<string, unknown>, key: string) {
	return booleanValue(record[key])
}

function modelInfoFromRemoteMetadata(id: string, metadata: Record<string, unknown>): Record<string, unknown> {
	const pricing = asRecord(metadata.pricing)
	const architecture = asRecord(metadata.architecture)
	const contextWindow =
		numberValue(metadata.context_length) ??
		numberValue(metadata.contextWindow) ??
		numberValue(metadata.max_context_length) ??
		numberValue(metadata.maxContextLength)
	const maxTokens =
		numberValue(metadata.max_completion_tokens) ??
		numberValue(metadata.maxTokens) ??
		numberValue(metadata.max_output_tokens) ??
		numberValue(metadata.maxOutputTokens)
	const inputPrice = parseModelPrice(pricing.prompt ?? pricing.input)
	const outputPrice = parseModelPrice(pricing.completion ?? pricing.output)
	const modality = [
		getString(metadata, "modality"),
		getString(architecture, "modality"),
		getString(architecture, "input_modalities"),
		getString(architecture, "output_modalities"),
	].join(" ").toLowerCase()
	const inferred = inferModelInfo(id, getString(metadata, "provider") || "")

	return {
		...inferred,
		name: getString(metadata, "name") || getString(metadata, "id") || id,
		contextWindow: contextWindow || inferred.contextWindow,
		maxTokens: maxTokens || inferred.maxTokens,
		supportsImages: modality.includes("image") || booleanField(metadata, "supportsImages") || inferred.supportsImages,
		supportsPromptCache: booleanField(metadata, "supportsPromptCache") || inferred.supportsPromptCache,
		supportsReasoning: booleanField(metadata, "supportsReasoning") || inferred.supportsReasoning,
		inputPrice,
		outputPrice,
		description: getString(metadata, "description") || inferred.description,
	}
}

function parseModelPrice(value: unknown) {
	if (value === undefined || value === null || value === "") {
		return undefined
	}
	const numeric = Number(value)
	if (!Number.isFinite(numeric)) {
		return undefined
	}
	// OpenRouter-compatible catalogs often report per-token prices. The WebView expects per-million.
	return numeric > 0 && numeric < 0.001 ? numeric * 1_000_000 : numeric
}

async function getOllamaModels(baseUrl: string) {
	const endpoint = `${normalizeOllamaRootBaseUrl(baseUrl)}/api/tags`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 2000)
	try {
		const response = await fetch(endpoint, { signal: controller.signal })
		if (!response.ok) {
			return []
		}

		const body = asRecord(await response.json())
		const models = Array.isArray(body.models) ? body.models : []
		return models
			.map((model) => getString(model, "name"))
			.filter((name): name is string => name.length > 0)
	} catch {
		return []
	} finally {
		clearTimeout(timeout)
	}
}

async function getOpenAiCompatibleModels(
	baseUrl: string,
	apiKey: string,
): Promise<{ ids: string[]; modelInfoById: Record<string, Record<string, unknown>>; error: string }> {
	const endpoint = `${normalizeOpenAiCompatibleBaseUrl(baseUrl)}/models`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 3000)
	try {
		const headers: Record<string, string> = {}
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`
		}
		const response = await fetch(endpoint, { headers, signal: controller.signal })
		if (!response.ok) {
			return { ids: [], modelInfoById: {}, error: `Model endpoint returned HTTP ${response.status}.` }
		}

		const body = asRecord(await response.json())
		const candidates = Array.isArray(body.data)
			? body.data
			: Array.isArray(body.models)
				? body.models
				: Array.isArray(body.values)
					? body.values
					: []
		const modelInfoById: Record<string, Record<string, unknown>> = {}
		const ids = candidates
			.map((model) => {
				const record = asRecord(model)
				const id = typeof model === "string" ? model : getString(record, "id") || getString(record, "name")
				if (id && Object.keys(record).length > 0) {
					modelInfoById[id] = modelInfoFromRemoteMetadata(id, record)
				}
				return id
			})
			.filter((id): id is string => id.length > 0)
		return { ids, modelInfoById, error: "" }
	} catch (error) {
		const message = error instanceof Error && error.name === "AbortError"
			? "Model endpoint timed out."
			: `Model endpoint could not be reached: ${stringify(error)}`
		return { ids: [], modelInfoById: {}, error: message }
	} finally {
		clearTimeout(timeout)
	}
}

function createInitialState() {
	const defaultProvider = process.env.CLINE_PROVIDER_ID || "ollama"
	const defaultModelId = process.env.CLINE_MODEL_ID || ""
	const browserSettings = { viewport: { width: 900, height: 600 }, remoteBrowserEnabled: false, disableToolUse: process.env.VSCLINE_ENABLE_WEB_FETCH !== "1" }
	const webFetchEnabled = isWebFetchEnabled(browserSettings)

	return {
		version: "vs2022-17.12-sdk-port",
		vsClineSdkCoverage: createSdkCoverageState(null),
		apiConfiguration: {
			actModeApiProvider: defaultProvider,
			planModeApiProvider: defaultProvider,
			apiKey: process.env.ANTHROPIC_API_KEY || "",
			openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
			openAiApiKey: process.env.OPENAI_API_KEY || process.env.CLINE_API_KEY || "",
			ollamaApiKey: process.env.OLLAMA_API_KEY || "",
			geminiApiKey: process.env.GEMINI_API_KEY || "",
			anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "",
			openAiBaseUrl: process.env.OPENAI_BASE_URL || process.env.CLINE_BASE_URL || "",
			ollamaBaseUrl: process.env.OLLAMA_BASE_URL || process.env.CLINE_BASE_URL || "http://localhost:11434",
			geminiBaseUrl: process.env.GEMINI_BASE_URL || "",
			actModeOpenAiBaseUrl: process.env.CLINE_BASE_URL || "",
			planModeOpenAiBaseUrl: process.env.CLINE_BASE_URL || "",
			actModeOpenAiApiKey: process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || "",
			planModeOpenAiApiKey: process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || "",
			actModeApiModelId: defaultModelId || "claude-sonnet-4-6",
			planModeApiModelId: defaultModelId || "claude-sonnet-4-6",
			actModeOpenAiModelId: defaultModelId || "claude-sonnet-4-6",
			planModeOpenAiModelId: defaultModelId || "claude-sonnet-4-6",
			actModeOllamaModelId: defaultModelId,
			planModeOllamaModelId: defaultModelId,
		},
		apiConfigurationProfiles: [] as Array<Record<string, unknown>>,
		activeApiConfigurationProfileId: "",
		clineMessages: [] as Array<Record<string, unknown>>,
		taskHistory: [] as Array<Record<string, unknown>>,
		taskSnapshots: {} as Record<string, { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> }>,
		shouldShowAnnouncement: false,
		autoApprovalSettings: { version: 1, enabled: false, favorites: [], maxRequests: 20, actions: {} },
		browserSettings,
		focusChainSettings: { enabled: false, remindClineInterval: 6 },
		uiLanguage: process.env.VSCLINE_UI_LANGUAGE === "en" ? "en" : "ko",
		preferredLanguage: "English",
		mode: "act",
		platform: "win32",
		environment: "production",
		telemetrySetting: "unset",
		distinctId: "vsclineagent-visualstudio-sdk",
		planActSeparateModelsSetting: true,
		enableCheckpointsSetting: true,
		checkpointManagerErrorMessage: null,
		mcpDisplayMode: "plain",
		globalClineRulesToggles: {},
		localClineRulesToggles: {},
		localCursorRulesToggles: {},
		localWindsurfRulesToggles: {},
		localAgentsRulesToggles: {},
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		shellIntegrationTimeout: 4000,
		terminalReuseEnabled: true,
		vscodeTerminalExecutionMode: "vscodeTerminal",
		terminalOutputLineLimit: 500,
		maxConsecutiveMistakes: 3,
		defaultTerminalProfile: "visual-studio-command-host",
		isNewUser: false,
		welcomeViewCompleted: true,
		onboardingModels: null,
		mcpResponsesCollapsed: false,
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		customPrompt: "",
		useAutoCondense: false,
		subagentsEnabled: false,
		scheduledAgentsEnabled: false,
		clineWebToolsEnabled: { user: webFetchEnabled, featureFlag: webFetchEnabled, reason: webFetchDisabledReason(browserSettings) || undefined },
		worktreesEnabled: { user: true, featureFlag: false },
		favoritedModelIds: [] as string[],
		lastDismissedInfoBannerVersion: 0,
		lastDismissedModelBannerVersion: 0,
		lastDismissedCliBannerVersion: 0,
		optOutOfRemoteConfig: true,
		remoteConfigSettings: {},
		backgroundCommandRunning: false,
		backgroundEditEnabled: false,
		doubleCheckCompletionEnabled: false,
		lazyTeammateModeEnabled: false,
		showFeatureTips: false,
		globalSkillsToggles: {},
		localSkillsToggles: {},
		openAiCodexIsAuthenticated: false,
		workspaceRoots: [],
		primaryRootIndex: 0,
		isMultiRootWorkspace: false,
		multiRootSetting: { user: false, featureFlag: false },
		hooksEnabled: true,
		nativeToolCallSetting: false,
		enableParallelToolCalling: false,
		currentTaskItem: null as Record<string, unknown> | null,
	}
}

function createSdkCoverageState(lastError: string | null) {
	return {
		mode: "sdk-wrapper",
		sdkPackage: "@cline/sdk",
		sdkVersion: readBundledSdkVersion(),
		status: lastError ? "error" : "ready",
		lastError: lastError || undefined,
		supported: [
			{ id: "sessions", label: "Sessions", owner: "cline-sdk" },
			{ id: "history", label: "History", owner: "cline-sdk" },
			{ id: "messages", label: "Messages", owner: "cline-sdk" },
			{ id: "settings", label: "Rules, workflows, skills", owner: "cline-sdk" },
			{ id: "tool-approval", label: "Tool approvals", owner: "cline-sdk" },
			{ id: "streaming", label: "Streaming output", owner: "cline-sdk" },
			{ id: "terminal-command-host", label: "VS command host attach/continue/cancel", owner: "visual-studio-host" },
			{ id: "checkpoints", label: "Checkpoint restore and snapshot comments", owner: "cline-sdk" },
			{ id: "usage", label: "Token and cost usage", owner: "cline-sdk" },
			{ id: "mcp", label: "MCP server settings and tools", owner: "cline-sdk" },
			{ id: "browser-devtools", label: "Browser DevTools sessions and phases", owner: "visual-studio-host" },
			{ id: "auth", label: "Provider-scoped OAuth and token state", owner: "cline-sdk" },
			{ id: "models", label: "Provider catalog refresh diagnostics", owner: "cline-sdk" },
			{ id: "worktrees", label: "Worktree routing and merge recovery", owner: "visual-studio-host" },
			{ id: "hooks", label: "Local lifecycle hooks", owner: "cline-sdk" },
			{ id: "scheduled-agents", label: "Workspace scheduled agents", owner: "cline-sdk" },
			{ id: "plugins-local", label: "Local plugin discovery and config status", owner: "cline-sdk" },
			{ id: "subagents", label: "Subagent and team progress", owner: "cline-sdk" },
		],
		partial: [
			{ id: "mcp-marketplace", label: "MCP marketplace install", owner: "cline-sdk" },
			{ id: "remote-mcp-oauth", label: "Remote MCP OAuth callbacks", owner: "cline-sdk" },
			{ id: "browser-auto-launch", label: "Automatic browser relaunch", owner: "cline-sdk" },
			{ id: "global-account-billing", label: "Global Cline account billing/org controls", owner: "cline-sdk" },
			{ id: "sdk-checkpoint-diff-streams", label: "SDK checkpoint diff streams", owner: "cline-sdk" },
			{ id: "scheduler-queue-controls", label: "Hosted scheduler queue controls", owner: "cline-sdk" },
			{ id: "provider-specific-catalogs", label: "Non-OpenAI provider-specific catalog APIs", owner: "cline-sdk" },
		],
		visualStudioUnsupported: [
			{
				id: "vscode-terminal-api",
				label: "VS Code terminal shell integration",
				reason: "Visual Studio 2022 exposes a different terminal automation surface than VS Code.",
			},
			{
				id: "vscode-editor-diff",
				label: "VS Code native diff/checkpoint UI",
				reason: "The VSIX must use Visual Studio editor and diff services instead of VS Code commands.",
			},
			{
				id: "vscode-auth",
				label: "VS Code authentication providers",
				reason: "Visual Studio 2022 does not provide the same extension authentication provider API.",
			},
			{
				id: "vscode-worktrees",
				label: "VS Code worktree UI commands",
				reason: "The upstream commands are VS Code command IDs and need Visual Studio-specific replacements.",
			},
			{
				id: "webview-uri",
				label: "VS Code webview URI helpers",
				reason: "WebView2 assets and local resource loading are hosted through the VSIX package.",
			},
		],
	}
}

const SUPPORTED_HOOK_NAMES: HookLifecycleName[] = [
	"TaskStart",
	"TaskResume",
	"TaskCancel",
	"TaskComplete",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
]

function normalizeHookName(value: string): HookLifecycleName | "" {
	const normalized = String(value || "").trim()
	return SUPPORTED_HOOK_NAMES.find((name) => name.toLowerCase() === normalized.toLowerCase()) || ""
}

function getGlobalHooksDirectory() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || process.cwd()
	return path.join(userProfile, ".cline", "hooks")
}

function getWorkspaceHooksDirectory(workspaceRoot: string) {
	return workspaceRoot ? path.join(workspaceRoot, ".clinerules", "hooks") : ""
}

function safeReadDirFiles(directory: string) {
	try {
		return fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(directory, entry.name))
	} catch {
		return []
	}
}

function isExecutableHookFile(filePath: string) {
	return [".ps1", ".cmd", ".bat", ".js"].includes(path.extname(filePath).toLowerCase())
}

function findHookScript(directory: string, hookName: HookLifecycleName) {
	return safeReadDirFiles(directory)
		.map((filePath) => ({ name: normalizeHookName(path.basename(filePath, path.extname(filePath))), path: filePath }))
		.find((item) => item.name === hookName && isExecutableHookFile(item.path))
}

function createHookScriptTemplate(hookName: string) {
	return [
		'$ErrorActionPreference = "Stop"',
		`# ${hookName} hook`,
		"# Hook context is available as JSON in $env:VSCLINE_HOOK_CONTEXT and stdin.",
		"$contextJson = $env:VSCLINE_HOOK_CONTEXT",
		'Write-Output "Hook executed: ' + hookName + '"',
		"",
	].join("\r\n")
}

function getHookToggleStorePath() {
	return path.join(path.dirname(getSettingsPath()), "hook-toggles.json")
}

function readHookToggleStore() {
	try {
		return JSON.parse(fs.readFileSync(getHookToggleStorePath(), "utf8")) as Record<string, unknown>
	} catch {
		return {}
	}
}

function writeHookToggleStore(store: Record<string, unknown>) {
	fs.mkdirSync(path.dirname(getHookToggleStorePath()), { recursive: true })
	fs.writeFileSync(getHookToggleStorePath(), JSON.stringify(store, null, 2), "utf8")
}

function normalizeHookWorkspaceKey(workspaceRoot: string) {
	try {
		return path.resolve(workspaceRoot || "").toLowerCase()
	} catch {
		return String(workspaceRoot || "").toLowerCase()
	}
}

function hookToggleKey(source: "global" | "workspace", workspaceRoot: string, hookName: string) {
	return source === "global" ? `global:${hookName}` : `workspace:${normalizeHookWorkspaceKey(workspaceRoot)}:${hookName}`
}

function getHookToggle(source: "global" | "workspace", workspaceRoot: string, hookName: string) {
	const store = readHookToggleStore()
	const value = store[hookToggleKey(source, workspaceRoot, hookName)]
	return typeof value === "boolean" ? value : true
}

function setHookToggle(source: "global" | "workspace", workspaceRoot: string, hookName: string, enabled: boolean) {
	const store = readHookToggleStore()
	store[hookToggleKey(source, workspaceRoot, hookName)] = enabled
	writeHookToggleStore(store)
}

function removeHookToggle(source: "global" | "workspace", workspaceRoot: string, hookName: string) {
	const store = readHookToggleStore()
	delete store[hookToggleKey(source, workspaceRoot, hookName)]
	writeHookToggleStore(store)
}

function createHookMetadata(
	hook: HookScript,
	status: "running" | "completed" | "failed" | "cancelled",
	context: Record<string, unknown>,
	result?: { exitCode: number; stderr: string; error?: string },
	jsonResponse?: Record<string, unknown>,
) {
	const toolName = getString(context, "toolName")
	const hasJsonResponse = Boolean(jsonResponse && Object.keys(jsonResponse).length > 0)
	const decision = hookDecisionFromResponse(jsonResponse)
	return {
		hookName: hook.name,
		toolName: toolName || undefined,
		status,
		exitCode: result?.exitCode,
		hasJsonResponse,
		jsonResponse: hasJsonResponse ? jsonResponse : undefined,
		blocked: decision.blocked || undefined,
		modifiedInput: decision.inputPatch && Object.keys(decision.inputPatch).length > 0 ? true : undefined,
		replaceInput: decision.replaceInput || undefined,
		modifiedInputKeys: decision.inputPatch && Object.keys(decision.inputPatch).length > 0 ? Object.keys(decision.inputPatch) : undefined,
		validationMessage: decision.validationMessage || undefined,
		contextInjectionKeys: decision.contextPatch && Object.keys(decision.contextPatch).length > 0 ? Object.keys(decision.contextPatch) : undefined,
		structuredDecision: decision.structuredDecision && Object.keys(decision.structuredDecision).length > 0 ? decision.structuredDecision : undefined,
		reason: decision.reason || undefined,
		error:
			status === "failed"
				? {
						type: "execution",
						message: result?.error || result?.stderr || "Hook failed.",
						scriptPath: hook.path,
					}
				: undefined,
	}
}

function extractHookJsonResponse(stdout: string): Record<string, unknown> | undefined {
	const text = String(stdout || "").trim()
	if (!text) {
		return undefined
	}

	const parsedWhole = tryParseJson(text)
	const wholeRecord = nonEmptyRecord(parsedWhole)
	if (wholeRecord) {
		return wholeRecord
	}
	if (Array.isArray(parsedWhole)) {
		for (let index = parsedWhole.length - 1; index >= 0; index--) {
			const record = nonEmptyRecord(parsedWhole[index])
			if (record) {
				return record
			}
		}
	}

	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	for (let index = lines.length - 1; index >= 0; index--) {
		const record = nonEmptyRecord(tryParseJson(lines[index]))
		if (record) {
			return record
		}
	}

	return undefined
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
	const record = asRecord(value)
	return Object.keys(record).length > 0 ? record : undefined
}

function hookDecisionFromResponse(response?: Record<string, unknown>): PreToolUseDecision {
	if (!response || Object.keys(response).length === 0) {
		return { blocked: false, reason: "" }
	}

	const action = (
		getString(response, "decision") ||
		getString(response, "action") ||
		getString(response, "permission") ||
		getString(response, "result") ||
		""
	).toLowerCase()
	const approved = response.approved
	const blocked =
		response.block === true ||
		response.blocked === true ||
		response.deny === true ||
		response.denied === true ||
		response.cancel === true ||
		response.cancelled === true ||
		approved === false ||
		["block", "blocked", "deny", "denied", "reject", "rejected", "cancel", "cancelled", "abort", "aborted", "disallow", "disallowed"].includes(
			action,
		)
	const reason =
		getString(response, "reason") ||
		getString(response, "message") ||
		getString(response, "error") ||
		(blocked ? "Blocked by PreToolUse hook." : "")
	const inputPatch = blocked ? undefined : getPreToolUseInputPatch(response)
	const replaceInput = inputPatch
		? response.replaceInput === true || response.replace_input === true || getString(response, "mode").toLowerCase() === "replace"
		: false
	const validationMessage =
		getString(response, "validationMessage") ||
		getString(response, "validation_message") ||
		getString(asRecord(response.validation), "message") ||
		""
	const contextPatch = blocked ? undefined : getPreToolUseContextPatch(response)
	const structuredDecision = getPreToolUseStructuredDecision(response, action)
	return { blocked, reason, inputPatch, replaceInput, validationMessage, contextPatch, structuredDecision }
}

function getPreToolUseInputPatch(response: Record<string, unknown>) {
	for (const key of ["inputPatch", "toolInputPatch", "argumentsPatch", "paramsPatch", "input", "toolInput", "arguments", "params"]) {
		const patch = asRecord(response[key])
		if (Object.keys(patch).length > 0) {
			return patch
		}
	}
	return undefined
}

function getPreToolUseContextPatch(response: Record<string, unknown>) {
	for (const key of ["contextPatch", "context", "contextInjection", "injectContext"]) {
		const patch = asRecord(response[key])
		if (Object.keys(patch).length > 0) {
			return patch
		}
	}
	return undefined
}

function getPreToolUseStructuredDecision(response: Record<string, unknown>, action: string) {
	const structured = asRecord(response.structuredDecision || response.toolDecision || response.metadata)
	const result = {
		...structured,
		action: action || undefined,
		severity: getString(response, "severity") || getString(structured, "severity") || undefined,
		category: getString(response, "category") || getString(structured, "category") || undefined,
	}
	return Object.keys(result).some((key) => result[key as keyof typeof result] !== undefined && result[key as keyof typeof result] !== "")
		? result
		: undefined
}

function mergeOptionalRecords(left?: Record<string, unknown>, right?: Record<string, unknown>) {
	if (!left || Object.keys(left).length === 0) {
		return right
	}
	if (!right || Object.keys(right).length === 0) {
		return left
	}
	return { ...left, ...right }
}

function applyPreToolUseInputPatch(input: Record<string, unknown>, approvalRequest: Record<string, unknown>, decision: PreToolUseDecision) {
	const patch = decision.inputPatch
	if (!patch || Object.keys(patch).length === 0) {
		return
	}

	if (decision.replaceInput === true) {
		for (const key of Object.keys(input)) {
			delete input[key]
		}
	}
	Object.assign(input, patch)

	let patchedExistingRequestInput = false
	for (const key of ["input", "params", "arguments"]) {
		if (approvalRequest[key] && typeof approvalRequest[key] === "object" && !Array.isArray(approvalRequest[key])) {
			if (decision.replaceInput === true) {
				const target = approvalRequest[key] as Record<string, unknown>
				for (const existingKey of Object.keys(target)) {
					delete target[existingKey]
				}
			}
			Object.assign(approvalRequest[key] as Record<string, unknown>, input)
			patchedExistingRequestInput = true
		}
	}
	if (!patchedExistingRequestInput) {
		approvalRequest.input = input
	}
}

async function executeHookScript(hook: HookScript, context: Record<string, unknown>) {
	const extension = path.extname(hook.path).toLowerCase()
	const contextJson = JSON.stringify(context)
	const cwd = getString(context, "workspaceRoot") || process.cwd()
	const timeoutMs = readPositiveIntEnv("VSCLINE_HOOK_TIMEOUT_MS", 30000)
	const outputLimit = readPositiveIntEnv("VSCLINE_HOOK_OUTPUT_CHARS", 12000)
	const command =
		extension === ".ps1"
			? "powershell.exe"
			: extension === ".js"
				? "node.exe"
				: "cmd.exe"
	const args =
		extension === ".ps1"
			? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", hook.path]
			: extension === ".js"
				? [hook.path]
				: ["/c", hook.path]

	return new Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }>((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		const child = childProcess.spawn(command, args, {
			cwd,
			env: {
				...process.env,
				VSCLINE_HOOK_CONTEXT: contextJson,
				VSCLINE_HOOK_NAME: hook.name,
				VSCLINE_HOOK_SOURCE: hook.source,
				VSCLINE_HOOK_SCRIPT: hook.path,
			},
			windowsHide: true,
		})

		const timer = setTimeout(() => {
			if (settled) {
				return
			}
			settled = true
			child.kill()
			resolve({
				exitCode: -1,
				stdout: truncateText(stdout, outputLimit),
				stderr: truncateText(stderr, outputLimit),
				error: `Hook timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
			})
		}, timeoutMs)

		child.stdout?.on("data", (chunk) => {
			stdout = truncateText(stdout + chunk.toString(), outputLimit)
		})
		child.stderr?.on("data", (chunk) => {
			stderr = truncateText(stderr + chunk.toString(), outputLimit)
		})
		child.on("error", (error) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timer)
			resolve({ exitCode: -1, stdout, stderr, error: error.message })
		})
		child.on("close", (code) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timer)
			resolve({ exitCode: code ?? 0, stdout: truncateText(stdout, outputLimit), stderr: truncateText(stderr, outputLimit) })
		})
		child.stdin?.end(contextJson)
	})
}

function createUnauthenticatedAccountState() {
	return {
		loggedIn: false,
		user: null,
		organizations: [],
		activeOrganization: null,
		isAuthenticated: false,
		openAiCodexIsAuthenticated: false,
		authStatus: "unauthenticated",
	}
}

function createVisualStudioAuthUnsupportedResponse(provider: string, url = "") {
	const label = providerAuthLabel(provider)
	const message =
		`${label} OAuth is not implemented in the Visual Studio 2022 host yet. ` +
		"Use a local API key or a provider-specific credential file where available."
	return {
		success: false,
		supported: false,
		provider,
		url,
		value: url,
		message,
		reason: "visual_studio_oauth_callback_not_implemented",
		...createUnauthenticatedAccountState(),
	}
}

function createFallbackProviderConfigFields(provider: string) {
	const providerId = normalizeSdkProviderId(provider)
	if (provider === "oca" || provider === "openAiCodex" || provider === "openai-codex" || provider === "account") {
		return {
			providerId,
			authMethod: "oauth",
			fields: {},
			description: `${providerAuthLabel(provider)} requires a Visual Studio-compatible OAuth callback/token exchange bridge.`,
		}
	}

	const fields: Record<string, Record<string, unknown>> = providerCredentialField(provider)
		? {
				apiKey: {
					label: `${providerAuthLabel(provider)} API Key`,
					placeholder: "Enter API Key...",
				},
			}
		: {}
	const baseUrlField = providerBaseUrlField(provider)
	if (baseUrlField) {
		fields.baseUrl = {
			label: "Base URL",
			placeholder: "https://...",
			optional: true,
		}
	}

	return {
		providerId,
		authMethod: Object.keys(fields).length > 0 ? "api-key" : "local",
		fields,
		description: `${providerAuthLabel(provider)} provider metadata is using the LIG VS fallback map.`,
	}
}

function createProviderAuthInfo(provider: string, message: unknown, bridge: OAuthCallbackSession | null = null) {
	const request = asRecord(message)
	if (provider === "openrouter") {
		const url = "https://openrouter.ai/settings/keys"
		return {
			success: true,
			supported: true,
			provider,
			url,
			value: url,
			message: "OpenRouter API key page opened. Paste the generated key into LIG VS settings.",
			authMode: "api_key",
		}
	}

	if (provider === "requesty") {
		const configuredBaseUrl = getString(request, "value") || getString(request, "baseUrl")
		const root = normalizeHttpUrl(configuredBaseUrl) || "https://app.requesty.ai"
		const url = new URL("api-keys", root.endsWith("/") ? root : `${root}/`).toString()
		return {
			success: true,
			supported: true,
			provider,
			url,
			value: url,
			message: "Requesty API key page opened. Paste the generated key into LIG VS settings.",
			authMode: "api_key",
		}
	}

	if (provider === "hicap") {
		const url = "https://hicap.ai"
		return {
			success: true,
			supported: true,
			provider,
			url,
			value: url,
			message: "Hicap provider page opened. Use a local API key in LIG VS settings.",
			authMode: "api_key",
		}
	}

	if (bridge || isOAuthBridgeProvider(provider)) {
		const callbackUrl = bridge?.callbackUrl || ""
		const authorizationUrl = bridge?.authorizationUrl || ""
		return {
			...createUnauthenticatedAccountState(),
			success: true,
			supported: true,
			provider,
			value: authorizationUrl || callbackUrl,
			url: authorizationUrl || undefined,
			authorizationUrl: authorizationUrl || undefined,
			callbackUrl,
			redirectUrl: callbackUrl,
			state: bridge?.state || "",
			authMode: "oauth_callback",
			authStatus: "pending",
			authorizationUrlSupported: Boolean(authorizationUrl),
			tokenExchangeSupported: bridge?.tokenExchangeSupported === true,
			message:
				authorizationUrl
					? `${providerAuthLabel(provider)} OAuth authorization URL opened. Complete sign-in in the browser and return to LIG VS through the localhost callback.`
					: `${providerAuthLabel(provider)} OAuth callback bridge is ready. Configure a provider authorization URL to open sign-in automatically.`,
		}
	}

	return createVisualStudioAuthUnsupportedResponse(provider)
}

function isOAuthBridgeProvider(provider: string) {
	const normalized = normalizeProviderValue(provider)
	const compact = String(provider || "").replace(/[_\s-]/g, "").toLowerCase()
	return normalized === "oca" || normalized === "openai-codex" || normalized === "account" || compact === "openaicodex"
}

function createOAuthAuthorizationRequest(provider: string, callbackUrl: string, state: string, request: Record<string, unknown>) {
	const authorizationBaseUrl = getString(request, "authorizationUrl") || getString(request, "authUrl") || oauthProviderEnv(provider, "AUTHORIZE_URL")
	const clientId = getString(request, "clientId") || oauthProviderEnv(provider, "CLIENT_ID")
	const scope = getString(request, "scope") || oauthProviderEnv(provider, "SCOPE")
	const audience = getString(request, "audience") || oauthProviderEnv(provider, "AUDIENCE")
	const tokenExchange = createOAuthTokenExchangeConfig(provider, request)
	const tokenExchangeSupported = Boolean(tokenExchange)
	if (!authorizationBaseUrl) {
		return { url: "", tokenExchangeSupported, tokenExchange }
	}

	try {
		const url = new URL(authorizationBaseUrl)
		if (!url.searchParams.has("response_type")) {
			url.searchParams.set("response_type", "code")
		}
		if (clientId && !url.searchParams.has("client_id")) {
			url.searchParams.set("client_id", clientId)
		}
		if (!url.searchParams.has("redirect_uri")) {
			url.searchParams.set("redirect_uri", callbackUrl)
		}
		if (!url.searchParams.has("state")) {
			url.searchParams.set("state", state)
		}
		if (scope && !url.searchParams.has("scope")) {
			url.searchParams.set("scope", scope)
		}
		if (audience && !url.searchParams.has("audience")) {
			url.searchParams.set("audience", audience)
		}
		return { url: url.toString(), tokenExchangeSupported, tokenExchange }
	} catch {
		return { url: "", tokenExchangeSupported, tokenExchange }
	}
}

function createOAuthTokenExchangeConfig(provider: string, request: Record<string, unknown>): OAuthTokenExchangeConfig | null {
	const tokenUrl = getString(request, "tokenUrl") || getString(request, "tokenEndpoint") || oauthProviderEnv(provider, "TOKEN_URL")
	const clientId = getString(request, "clientId") || oauthProviderEnv(provider, "CLIENT_ID")
	if (!tokenUrl || !clientId) {
		return null
	}

	return {
		tokenUrl,
		clientId,
		clientSecret: getString(request, "clientSecret") || oauthProviderEnv(provider, "CLIENT_SECRET") || undefined,
		scope: getString(request, "scope") || oauthProviderEnv(provider, "SCOPE") || undefined,
		codeVerifier: getString(request, "codeVerifier") || getString(request, "code_verifier") || oauthProviderEnv(provider, "CODE_VERIFIER") || undefined,
		authMethod: getString(request, "authMethod") || oauthProviderEnv(provider, "AUTH_METHOD") || undefined,
	}
}

function parseUrlFragmentParams(url: URL) {
	const fragment = url.hash.replace(/^#/, "")
	return new URLSearchParams(fragment)
}

function hasConfiguredOAuthAuthorizationUrl(provider: string, request: Record<string, unknown> = {}) {
	return Boolean(getString(request, "authorizationUrl") || getString(request, "authUrl") || oauthProviderEnv(provider, "AUTHORIZE_URL"))
}

function hasConfiguredOAuthTokenExchange(provider: string, request: Record<string, unknown> = {}) {
	return Boolean(createOAuthTokenExchangeConfig(provider, request))
}

function oauthProviderEnv(provider: string, suffix: string) {
	const normalized = normalizeProviderValue(provider) || String(provider || "account")
	const envKey = normalized.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
	return process.env[`VSCLINE_${envKey}_OAUTH_${suffix}`] || process.env[`LIGVS_${envKey}_OAUTH_${suffix}`] || process.env[`VSCLINE_OAUTH_${suffix}`] || ""
}

function oauthCredentialsField(provider: string) {
	const normalized = normalizeProviderValue(provider)
	switch (normalized) {
		case "openai-codex":
			return "openAiCodexOAuthCredentials"
		case "oca":
			return "ocaOAuthCredentials"
		case "account":
			return "ligVsOAuthCredentials"
		default:
			return `${normalized || "provider"}OAuthCredentials`
	}
}

function isOAuthTokenBlobProvider(provider: string) {
	const normalized = normalizeProviderValue(provider)
	return normalized === "openai-codex" || normalized === "oca" || normalized === "account"
}

function redactUrl(value: string) {
	try {
		const url = new URL(value)
		url.search = ""
		url.hash = ""
		return url.toString()
	} catch {
		return value ? "[configured]" : ""
	}
}

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;"
			case "<":
				return "&lt;"
			case ">":
				return "&gt;"
			case '"':
				return "&quot;"
			case "'":
				return "&#39;"
			default:
				return char
		}
	})
}

function providerAuthLabel(provider: string) {
	switch (provider) {
		case "anthropic":
			return "Anthropic"
		case "openrouter":
			return "OpenRouter"
		case "openai":
		case "openai-compatible":
			return "OpenAI Compatible"
		case "openai-native":
			return "OpenAI"
		case "ollama":
			return "Ollama"
		case "lmstudio":
			return "LM Studio"
		case "litellm":
			return "LiteLLM"
		case "requesty":
			return "Requesty"
		case "vercel-ai-gateway":
			return "Vercel AI Gateway"
		case "groq":
			return "Groq"
		case "huggingface":
			return "Hugging Face"
		case "baseten":
			return "Baseten"
		case "hicap":
			return "Hicap"
		case "sapaicore":
			return "SAP AI Core"
		case "aihubmix":
			return "AIHubMix"
		case "nousResearch":
			return "Nous Research"
		case "openAiCodex":
		case "openai-codex":
			return "OpenAI Codex"
		case "oca":
			return "OCA"
		case "account":
			return "LIG VS account"
		default:
			return provider || "Provider"
	}
}

function normalizeHttpUrl(value: string) {
	const raw = String(value || "").trim()
	if (!raw) {
		return ""
	}
	try {
		return new URL(raw).toString()
	} catch {
		try {
			return new URL(`https://${raw}`).toString()
		} catch {
			return ""
		}
	}
}

function readBundledSdkVersion() {
	return "0.0.42"
}

function grpcHandled(...webviewMessages: unknown[]) {
	return {
		handled: true,
		owner: "sidecar",
		webviewMessages,
	}
}

function grpcResponse(requestId: string, message: unknown, isStreaming: boolean) {
	return {
		type: "grpc_response",
		grpc_response: {
			request_id: requestId,
			message,
			is_streaming: isStreaming,
		},
	}
}

function grpcError(requestId: string, error: string, isStreaming: boolean) {
	return {
		type: "grpc_response",
		grpc_response: {
			request_id: requestId,
			error,
			is_streaming: isStreaming,
		},
	}
}
