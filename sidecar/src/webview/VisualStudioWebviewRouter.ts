import fs from "node:fs"
import path from "node:path"
import { VisualStudioHostProvider } from "../host/VisualStudioHostProvider"
import { sendHostRequest, type JsonRpcConnection } from "../ipc/types"
import type { AskQuestionResult, ClineSdkRuntime, ToolApprovalResult } from "../sdk/ClineSdkRuntime"
import { logInteraction } from "../diagnostics/InteractionLog"

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

export class VisualStudioWebviewRouter {
	private clineSdk: ClineSdkRuntime | null = null
	private readonly stateStreamRequestIds = new Set<string>()
	private readonly partialMessageStreamRequestIds = new Set<string>()
	private readonly taskSnapshots = new Map<string, { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> }>()
	private readonly state: ReturnType<typeof createInitialState>
	private pendingApproval:
		| {
				resolve: (value: ToolApprovalResult) => void
				timeout: NodeJS.Timeout
		  }
		| null = null
	private pendingQuestion:
		| {
				resolve: (value: AskQuestionResult) => void
				timeout: NodeJS.Timeout
		  }
		| null = null
	private messageSequence = 0
	private activePartialTextTs: number | null = null
	private partialIdleTimer: NodeJS.Timeout | null = null
	private taskIdleTimer: NodeJS.Timeout | null = null
	private lastTaskActivityAt = 0
	private lastToolSummaries: string[] = []
	private readonly recentlyTrackedChangePaths = new Map<string, number>()
	private readonly pendingChangeSummaries = new Map<string, TrackedChangeSummary>()
	private changeSummaryTimer: NodeJS.Timeout | null = null

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
		"McpService.subscribeToMcpServers",
		"ModelsService.subscribeToOpenRouterModels",
		"ModelsService.subscribeToLiteLlmModels",
	])

	constructor(private readonly connection: JsonRpcConnection) {
		this.state = loadInitialState()
	}

	setClineSdk(clineSdk: ClineSdkRuntime) {
		this.clineSdk = clineSdk
	}

	async requestToolApproval(request: unknown): Promise<ToolApprovalResult> {
		logInteraction("sdk->sidecar", "toolApproval.request", request)
		const approvalRequest = asRecord(request)
		const toolName = getString(approvalRequest, "toolName") || getString(approvalRequest, "name") || getString(approvalRequest, "tool")
		const input = asRecord(approvalRequest.input || approvalRequest.params || approvalRequest.arguments)
		const mappedToolName = mapToolName(toolName)
		if (shouldAutoApproveTool(toolName, this.state.autoApprovalSettings)) {
			return { approved: true, reason: "Auto-approved by Visual Studio settings." }
		}
		const ask = mappedToolName === "executeCommand" ? "command" : "tool"
		const text =
			ask === "command"
				? JSON.stringify({
						command: getCommandText(input),
						description: getString(approvalRequest, "description") || getString(approvalRequest, "reason") || "Cline wants to run this command.",
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
			clearTimeout(this.pendingApproval.timeout)
			this.pendingApproval.resolve({ approved: false, reason: "Superseded by a newer Cline tool approval request." })
			this.pendingApproval = null
		}

		this.addMessage({ type: "ask", ask, text })
		this.updateCurrentTaskItem()
		await this.broadcastState()

		return new Promise<ToolApprovalResult>((resolve) => {
			const timeout = setTimeout(() => {
				if (this.pendingApproval?.resolve === resolve) {
					this.pendingApproval = null
				}
				resolve({ approved: false, reason: "Timed out waiting for Visual Studio tool approval." })
			}, 30 * 60 * 1000)
			this.pendingApproval = { resolve, timeout }
		})
	}

	async requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> {
		logInteraction("sdk->sidecar", "question.request", { question, options })
		if (this.pendingQuestion) {
			clearTimeout(this.pendingQuestion.timeout)
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
			const timeout = setTimeout(() => {
				if (this.pendingQuestion?.resolve === resolve) {
					this.pendingQuestion = null
				}
				resolve("")
			}, 30 * 60 * 1000)
			this.pendingQuestion = { resolve, timeout }
		})
	}

	handleSdkEvent(event: unknown) {
		logInteraction("sdk->sidecar", "sdk.event", event)
		const record = asRecord(event)
		const type = getString(record, "type")
		const payload = asRecord(record.payload)

		if (type === "agent_event") {
			this.handleAgentEvent(asRecord(payload.event))
			return
		}

		if (type === "vscline_file_changed") {
			this.handleFileChangedEvent(payload).catch((error) => console.error(error))
			return
		}

		if (type === "status") {
			const status = getString(payload, "status")
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.noteTaskActivity(status || type)
			if (isTerminalSdkStatus(status)) {
				this.clearTaskIdleWatchdog()
				const activeText = this.getActivePartialText()
				this.finalizeActivePartialText()
				if (status === "completed" && activeText) {
					this.addCompletionResult(activeText)
				} else if (status === "completed" && !this.hasAssistantTextAfterLastUserMessage()) {
					this.addCompletionResult(this.buildTerminalCompletionFallback(status))
				} else if (status === "failed" || status === "error" || status === "cancelled" || status === "stopped") {
					this.addCompletionResult(this.buildTerminalCompletionFallback(status))
				}
				this.clineSdk?.markSessionInactive(sessionId)
				this.updateCurrentTaskItem()
				this.broadcastState().catch((error) => console.error(error))
				return
			}
			if (status && status !== "idle") {
				this.addApiRequestStarted(status)
			}
			this.broadcastState().catch((error) => console.error(error))
			return
		}

		if (type === "ended") {
			const sessionId = getString(payload, "sessionId")
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.noteTaskActivity(type)
			this.clearTaskIdleWatchdog()
			const activeText = this.getActivePartialText()
			this.finalizeActivePartialText()
			if (activeText) {
				this.addCompletionResult(activeText)
			} else if (!this.hasAssistantTextAfterLastUserMessage()) {
				this.addCompletionResult(this.buildTerminalCompletionFallback(getString(payload, "reason") || "ended"))
			}
			this.clineSdk?.markSessionInactive(sessionId)
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
			this.stateStreamRequestIds.delete(requestId)
			this.partialMessageStreamRequestIds.delete(requestId)
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
		const service = request.service || ""
		const method = request.method || ""
		const requestId = readRequestId(request)
		const isStreaming = request.is_streaming === true || request.isStreaming === true
		const key = `${service}.${method}`

		if (!requestId) {
			return null
		}

		if (isStreaming) {
			return this.handleStreamingRequest(key, requestId)
		}

		try {
			return await this.handleUnaryRequest(key, requestId, request.message)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.addMessage({ type: "say", say: "error", text: message })
			this.updateCurrentTaskItem()
			await this.broadcastState()
			return grpcHandled(grpcError(requestId, message, false))
		}
	}

	private handleStreamingRequest(key: string, requestId: string) {
		if (key === "StateService.subscribeToState") {
			this.stateStreamRequestIds.add(requestId)
			return grpcHandled(grpcResponse(requestId, { stateJson: JSON.stringify(this.state) }, true))
		}

		if (key === "AccountService.subscribeToAuthStatusUpdate") {
			return grpcHandled(grpcResponse(requestId, { loggedIn: false, user: null }, true))
		}

		if (key === "UiService.subscribeToPartialMessage") {
			this.partialMessageStreamRequestIds.add(requestId)
			return grpcHandled()
		}

		if (key === "OcaAccountService.ocaSubscribeToAuthStatusUpdate") {
			return grpcHandled(grpcResponse(requestId, { loggedIn: false, user: null }, true))
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
				await host.envClient.openExternal({ value: getString(message, "url") })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "UiService.openWalkthrough":
			case "UiService.setTerminalExecutionMode":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "WebService.openInBrowser":
				await host.envClient.openExternal({ value: getString(message, "value") })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "WebService.checkIsImageUrl":
				return grpcHandled(grpcResponse(requestId, { value: false }, false))

			case "WebService.fetchOpenGraphData":
				return grpcHandled(grpcResponse(requestId, {}, false))

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

			case "StateService.updateSettings":
			case "StateService.updateAutoApprovalSettings":
			case "ModelsService.updateApiConfigurationProto":
			case "ModelsService.updateApiConfiguration":
				this.applySettings(message)
				savePersistedState(this.state)
				return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())

			case "StateService.togglePlanActModeProto":
				this.state.mode = this.state.mode === "plan" ? "act" : "plan"
				savePersistedState(this.state)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

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
					await this.sendAskResponse(message)
					return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())
				}
				await this.startNewTask(message, { broadcast: false })
				return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())

			case "TaskService.askResponse":
				await this.sendAskResponse(message)
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.cancelTask":
				await this.cancelTask()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.getTaskHistory":
				await this.refreshTaskHistoryFromSdk()
				return grpcHandled(grpcResponse(requestId, { tasks: this.state.taskHistory }, false))

			case "TaskService.getTotalTasksSize":
				await this.refreshTaskHistoryFromSdk()
				return grpcHandled(grpcResponse(requestId, { value: this.state.taskHistory.length }, false))

			case "TaskService.showTaskWithId":
				await this.showTaskWithId(getString(message, "value") || getString(message, "taskId"))
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.deleteTasksWithIds":
				await this.deleteTasks(getStringArray(message, "value"))
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.deleteAllTaskHistory":
				this.taskSnapshots.clear()
				this.state.taskHistory = []
				if (!this.state.currentTaskItem) {
					this.state.clineMessages = []
				}
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "CheckpointsService.checkpointRestore":
				await this.restoreCheckpoint(message)
				return grpcHandled(grpcResponse(requestId, { value: true }, false))

			case "CheckpointsService.checkpointDiff":
				return grpcHandled(grpcResponse(requestId, { text: "Checkpoint diff is owned by the Cline SDK session store in this VSIX wrapper." }, false))

			case "FileService.refreshRules":
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.refreshSkills":
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkSkills(), false))

			case "FileService.toggleClineRule":
				await this.toggleSdkSetting("rules", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.toggleWorkflow":
				await this.toggleSdkSetting("workflows", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.toggleSkill":
				await this.toggleSdkSetting("skills", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkSkills(), false))

			case "FileService.openVsClineDiff": {
				const leftPath = getString(message, "leftPath") || getString(message, "beforePath")
				const rightPath = getString(message, "rightPath") || getString(message, "afterPath") || getString(message, "filePath")
				const title = getString(message, "title") || (rightPath ? `Cline change: ${path.basename(rightPath)}` : "Cline change")
				if (leftPath && rightPath) {
					await VisualStudioHostProvider.create(this.connection).diffClient.openDiff({ leftPath, rightPath, title })
				} else if (rightPath) {
					await VisualStudioHostProvider.create(this.connection).windowClient.openFile({ filePath: rightPath })
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

			case "TaskService.toggleTaskFavorite":
				this.toggleTaskFavorite(getString(message, "taskId"), asRecord(message).isFavorited === true)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			default:
				return null
		}
	}

	private async startNewTask(message: unknown, options: { broadcast?: boolean } = {}) {
		if (!this.clineSdk) {
			throw new Error("Cline SDK runtime is not attached.")
		}

		await this.clineSdk.stop({})
		const text = getString(message, "text")
		const images = getStringArray(message, "images")
		const files = getStringArray(message, "files")
		const workspaceRoots = await VisualStudioHostProvider.create(this.connection).workspaceClient.getWorkspacePaths({})
		const cwd = workspaceRoots[0] || process.cwd()
		const taskItem = createHistoryItem(createId(), text, cwd, this.getModelId())

		this.state.clineMessages = []
		this.lastToolSummaries = []
		this.state.currentTaskItem = taskItem
		this.state.taskHistory = [taskItem, ...this.state.taskHistory.filter((item) => item.id !== taskItem.id)]
		this.addMessage({ type: "say", say: "task", text, images, files })
		this.addApiRequestStarted("Cline SDK started.")
		this.noteTaskActivity("start")
		this.updateCurrentTaskItem()
		if (options.broadcast !== false) {
			await this.broadcastState()
		}

		this.clineSdk.startSession({
			prompt: text,
			cwd,
			userImages: images,
			userFiles: files,
			interactive: true,
			config: await this.buildSdkConfig(cwd),
			toolPolicies: createToolPolicies(this.state.autoApprovalSettings),
		}).then(async (result) => {
			const resultRecord = asRecord(result)
			const agentResult = asRecord(resultRecord.result)
			const resultText = getString(agentResult, "text") || getString(agentResult, "outputText")
			const sessionId = getString(resultRecord, "sessionId")
			if (resultText) {
				this.addCompletionResult(resultText)
				this.clineSdk?.markSessionInactive(sessionId)
			} else if (agentResult && Object.keys(agentResult).length > 0 && !this.hasAssistantTextAfterLastUserMessage()) {
				this.addCompletionResult(this.buildTerminalCompletionFallback(getString(agentResult, "finishReason") || "completed"))
				this.clineSdk?.markSessionInactive(sessionId)
			}
			this.updateCurrentTaskItem()
			await this.broadcastState()
		}).catch(async (error) => {
			this.clearTaskIdleWatchdog()
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
			this.updateCurrentTaskItem()
			await this.broadcastState()
		})
	}

	private async sendAskResponse(message: unknown) {
		if (!this.clineSdk) {
			throw new Error("Cline SDK runtime is not attached.")
		}

		const responseType = getString(message, "responseType")
		if (this.pendingApproval) {
			const approved = responseType === "yesButtonClicked"
			const feedback = buildTaskInputWithAttachments(
				getString(message, "text"),
				getStringArray(message, "images"),
				getStringArray(message, "files"),
			)
			const pending = this.pendingApproval
			this.pendingApproval = null
			clearTimeout(pending.timeout)
			this.addMessage({
				type: "say",
				say: "user_feedback",
				text: feedback.trim() || (approved ? "Approved" : "Rejected"),
				images: getStringArray(message, "images"),
				files: getStringArray(message, "files"),
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			pending.resolve({ approved, reason: feedback.trim() || (approved ? "Approved in Visual Studio." : "Rejected in Visual Studio.") })
			return
		}

		if (this.pendingQuestion) {
			const answer = getAskResponseText(message)
			const text = buildTaskInputWithAttachments(answer, getStringArray(message, "images"), getStringArray(message, "files"))
			const pending = this.pendingQuestion
			this.pendingQuestion = null
			clearTimeout(pending.timeout)
			this.removeAskMessages("followup")
			this.addMessage({
				type: "say",
				say: "user_feedback",
				text: text.trim() || "No response.",
				images: getStringArray(message, "images"),
				files: getStringArray(message, "files"),
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			pending.resolve(text.trim())
			return
		}

		const text = buildTaskInputWithAttachments(getString(message, "text"), getStringArray(message, "images"), getStringArray(message, "files"))
		if (!text.trim()) {
			return
		}

		if (!this.clineSdk.status.activeSessionId) {
			await this.startNewTask(
				{
					text: getString(message, "text"),
					images: getStringArray(message, "images"),
					files: getStringArray(message, "files"),
				},
				{ broadcast: true },
			)
			return
		}

		this.removeTerminalAskMessages()
		this.addMessage({ type: "say", say: "user_feedback", text })
		await this.broadcastState()

		this.clineSdk.send({
			prompt: getString(message, "text"),
			userImages: getStringArray(message, "images"),
			userFiles: getStringArray(message, "files"),
		}).catch(async (error) => {
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
			await this.broadcastState()
		})
	}

	private async cancelTask() {
		if (this.clineSdk) {
			await this.clineSdk.stop({})
		}
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.finalizeActivePartialText()
		this.addMessage({ type: "ask", ask: "resume_task", text: "Task was cancelled." })
		this.state.currentTaskItem = null
		this.updateCurrentTaskItem()
		await this.broadcastState()
	}

	private async clearTask() {
		if (this.clineSdk) {
			await this.clineSdk.stop({})
		}
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.state.currentTaskItem = null
		this.state.clineMessages = []
		await this.broadcastState()
	}

	private async showTaskWithId(taskId: string) {
		if (this.clineSdk && taskId) {
			const session = asRecord(await this.clineSdk.getSession({ sessionId: taskId }))
			const messages = await this.clineSdk.readMessages({ sessionId: taskId })
			const taskItem = sdkSessionToHistoryItem(session)
			this.state.currentTaskItem = taskItem
			this.state.clineMessages = sdkMessagesToClineMessages(messages, taskItem)
			this.taskSnapshots.set(taskId, {
				taskItem: { ...taskItem },
				messages: this.state.clineMessages.map((message) => ({ ...message })),
			})
			await this.broadcastState()
			return
		}

		const snapshot = this.taskSnapshots.get(taskId)
		if (!snapshot) {
			return
		}

		this.state.currentTaskItem = { ...snapshot.taskItem }
		this.state.clineMessages = snapshot.messages.map((message) => ({ ...message }))
		await this.broadcastState()
	}

	private async deleteTasks(taskIds: string[]) {
		if (taskIds.length === 0) {
			return
		}

		const ids = new Set(taskIds)
		for (const id of ids) {
			await this.clineSdk?.deleteSession({ sessionId: id }).catch(() => false)
			this.taskSnapshots.delete(id)
		}
		this.state.taskHistory = this.state.taskHistory.filter((item) => !ids.has(String(item.id || "")))
		if (this.state.currentTaskItem && ids.has(String(this.state.currentTaskItem.id || ""))) {
			this.state.currentTaskItem = null
			this.state.clineMessages = []
		}
	}

	private toggleTaskFavorite(taskId: string, isFavorited: boolean) {
		if (!taskId) {
			return
		}

		this.state.taskHistory = this.state.taskHistory.map((item) =>
			item.id === taskId ? { ...item, isFavorited } : item,
		)
		const snapshot = this.taskSnapshots.get(taskId)
		if (snapshot) {
			snapshot.taskItem = { ...snapshot.taskItem, isFavorited }
		}
		if (this.state.currentTaskItem?.id === taskId) {
			this.state.currentTaskItem = { ...this.state.currentTaskItem, isFavorited }
		}
		this.clineSdk?.updateSession({ sessionId: taskId, metadata: { isFavorited } }).catch(() => undefined)
	}

	private async refreshTaskHistoryFromSdk() {
		if (!this.clineSdk) {
			return
		}

		const sdkHistory = await this.clineSdk.listHistory({ limit: 200 }).catch(() => null)
		if (Array.isArray(sdkHistory)) {
			this.state.taskHistory = sdkHistory.map((session) => sdkSessionToHistoryItem(asRecord(session)))
		}
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
				config: await this.buildSdkConfig(cwd),
				interactive: true,
				toolPolicies: createToolPolicies(this.state.autoApprovalSettings),
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

	private handleAgentEvent(event: Record<string, unknown>) {
		const type = getString(event, "type")
		const contentType = getString(event, "contentType")
		this.noteTaskActivity(type || contentType || "agent_event")

		if (type === "content_start" && contentType === "text") {
			const text = getString(event, "accumulated") || getString(event, "text")
			if (text) {
				this.upsertPartialText(text)
			} else if (!this.state.clineMessages.some((message) => message.say === "api_req_started" && message.partial === true)) {
				this.addApiRequestStarted("Cline SDK is thinking...", { partial: true })
			}
		}

		if (type === "content_end" && contentType === "text") {
			const text = getString(event, "text") || getString(event, "accumulated")
			if (text && this.activePartialTextTs) {
				this.upsertMessage(this.activePartialTextTs, { type: "say", say: "text", text, partial: false })
				this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.activePartialTextTs))
				this.activePartialTextTs = null
			} else if (text) {
				this.addMessage({ type: "say", say: "text", text })
			}
		}

		if (type === "content_start" && contentType === "tool") {
			this.clearPartialIdleWatchdog()
			this.activePartialTextTs = null
		}

		if (type === "content_end" && contentType === "tool") {
			const toolName = getString(event, "toolName")
			const error = getString(event, "error")
			const isCommand = toolName === "bash" || toolName === "run_commands"
			const mappedToolName = mapToolName(toolName)
			const input = asRecord(event.input)
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
			this.addMessage({
				type: "say",
				say: isCommand ? "command_output" : "tool",
				text,
				commandCompleted: isCommand ? true : undefined,
			})
		}

		if (type === "tool-finished") {
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
			this.addMessage({ type: "say", say: "tool", text })
		}

		if (type === "assistant-message") {
			const text = contentToText(asRecord(event.message).content)
			if (text.trim()) {
				this.finalizeActivePartialText()
				this.addMessage({ type: "say", say: "text", text })
			}
		}

		if (type === "run-finished") {
			const result = asRecord(event.result)
			const text = getString(result, "outputText")
			this.finalizeActivePartialText()
			this.addCompletionResult(text || this.buildTerminalCompletionFallback(getString(result, "status") || "completed"))
		}

		if (type === "run-failed") {
			this.finalizeActivePartialText()
			this.addCompletionResult(this.buildTerminalCompletionFallback("failed"))
		}

		if (type === "usage") {
			const usage = asRecord(event.usage)
			this.updateCurrentTaskItem({
				tokensIn: numberValue(event.totalInputTokens) ?? numberValue(usage.inputTokens),
				tokensOut: numberValue(event.totalOutputTokens) ?? numberValue(usage.outputTokens),
				cacheReads: numberValue(event.totalCacheReadTokens) ?? numberValue(usage.cacheReadTokens),
				cacheWrites: numberValue(event.totalCacheWriteTokens) ?? numberValue(usage.cacheWriteTokens),
				totalCost: numberValue(event.totalCost) ?? numberValue(usage.totalCost) ?? numberValue(usage.cost),
			})
		}

		if (type === "done") {
			const text = getString(event, "text")
			this.finalizeActivePartialText()
			if (text) {
				this.addCompletionResult(text)
			}
		}

		if (type === "error") {
			this.addMessage({ type: "say", say: "error", text: stringify(event.error) })
		}

		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
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
			content: `Cline ${actionParts.join(", ") || "changed"} file${files.length > 1 ? "s" : ""}.`,
			files,
			additions,
			deletions,
		})
		this.addMessage({ type: "say", say: "tool", text })
		this.updateCurrentTaskItem()
		await this.broadcastState()
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

	private async buildSdkConfig(cwd: string) {
		const apiConfig = asRecord(this.state.apiConfiguration)
		const modePrefix = this.state.mode === "plan" ? "planMode" : "actMode"
		const providerId = normalizeProviderId(getString(apiConfig, `${modePrefix}ApiProvider`) || process.env.CLINE_PROVIDER_ID || "anthropic")
		const sdkProviderId = normalizeSdkProviderId(providerId)
		const configuredBaseUrl = resolveBaseUrl(apiConfig, providerId)
		const modelLookupBaseUrl = providerId === "ollama" ? normalizeOllamaRootBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const sdkBaseUrl = providerId === "ollama" ? normalizeOllamaOpenAiBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const modelId = await this.resolveEffectiveModelId(apiConfig, providerId, modePrefix, modelLookupBaseUrl)
		const apiKey = resolveApiKey(apiConfig, providerId) || process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || ""

		return {
			providerId: sdkProviderId,
			modelId,
			apiKey,
			baseUrl: sdkBaseUrl || undefined,
			cwd,
			workspaceRoot: cwd,
			mode: this.state.mode === "plan" ? "plan" : "act",
			enableTools: true,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			maxIterations: readPositiveIntEnv("VSCLINE_MAX_ITERATIONS", 12),
			maxParallelToolCalls: readPositiveIntEnv("VSCLINE_MAX_PARALLEL_TOOL_CALLS", 2),
			maxTokensPerTurn: readPositiveIntEnv("VSCLINE_MAX_TOKENS_PER_TURN", 4096),
			apiTimeoutMs: readPositiveIntEnv("VSCLINE_API_TIMEOUT_MS", 180000),
			checkpoint: {
				enabled: this.state.enableCheckpointsSetting !== false,
			},
			execution: {
				maxConsecutiveMistakes: readPositiveIntEnv("VSCLINE_MAX_CONSECUTIVE_MISTAKES", 3),
				reminderAfterIterations: readPositiveIntEnv("VSCLINE_REMINDER_AFTER_ITERATIONS", 6),
				loopDetection: readLoopDetectionConfig(),
			},
			systemPrompt: "You are Cline running inside Visual Studio 2022 through the VsClineAgent SDK wrapper.",
		}
	}

	private addCompletionResult(text: string) {
		if (!text) {
			return
		}

		this.clearTaskIdleWatchdog()
		this.finalizeActivePartialText()
		if (this.state.clineMessages.some((message) => message.say === "completion_result" || message.ask === "completion_result")) {
			return
		}

		const lastText = [...this.state.clineMessages]
			.reverse()
			.find((message) => message.say === "text" && message.partial !== true)
		const completionText = getString(lastText, "text").trim() === text.trim() ? "" : text
		this.addMessage({ type: "ask", ask: "completion_result", text: completionText })
	}

	private hasAssistantTextAfterLastUserMessage() {
		const lastUserIndex = findLastIndex(
			this.state.clineMessages,
			(message) => getString(message, "say") === "user_feedback" || getString(message, "say") === "task",
		)
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
				? `Cline SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다.\n\n마지막으로 확인된 작업:\n${toolSummary}`
				: "Cline SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다."
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
		const apiConfigurationUpdate = extractApiConfigurationUpdate(request)
		if (Object.keys(apiConfigurationUpdate).length > 0) {
			this.state.apiConfiguration = normalizeApiConfiguration({
				...this.state.apiConfiguration,
				...compactApiConfiguration(apiConfigurationUpdate),
			}) as typeof this.state.apiConfiguration
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
		}
		for (const key of ["apiConfiguration", "autoApprovalSettings", "mode", "planActSeparateModelsSetting"] as const) {
			if (key in request && key !== "apiConfiguration" && key !== "autoApprovalSettings") {
				;(this.state as Record<string, unknown>)[key] = request[key]
			}
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
		if (isMeaninglessToolMessage(message)) {
			logInteraction("sidecar", "skipMeaninglessToolMessage", message)
			return
		}
		this.state.clineMessages.push({
			ts: Date.now() + this.messageSequence++,
			...normalizeClineMessagePayload(message),
		})
	}

	private removeTerminalAskMessages() {
		this.state.clineMessages = this.state.clineMessages.filter((message) => {
			const ask = getString(message, "ask")
			return ask !== "completion_result" && ask !== "resume_task" && ask !== "resume_completed_task"
		})
	}

	private removeAskMessages(askKind: string) {
		this.state.clineMessages = this.state.clineMessages.filter((message) => getString(message, "ask") !== askKind)
	}

	private addToolActivityMessage(tool: string, input: Record<string, unknown>, fallback: unknown) {
		this.addMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify({
				tool,
				path: tool === "searchFiles" ? getToolPath(input) || "/" : getToolPathFromUnknown(input),
				regex: tool === "searchFiles" ? getSearchQuery(input) : undefined,
				filePattern: tool === "searchFiles" ? getSearchFilePattern(input) : undefined,
				command: tool === "executeCommand" ? getCommandText(input) : undefined,
				content: summarizeToolInput(input) || stringify(fallback),
			}),
		})
	}

	private finalizeActivePartialText() {
		this.clearPartialIdleWatchdog()
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

	private addApiRequestStarted(request: string, options: { partial?: boolean } = {}) {
		this.addMessage({
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request,
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				cost: 0,
			}),
			partial: options.partial === true ? true : undefined,
		})
	}

	private upsertPartialText(text: string) {
		if (!this.activePartialTextTs) {
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
		this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.activePartialTextTs))
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

			logInteraction("sidecar", "partialIdleComplete", { timeoutMs, textLength: text.length })
			this.finalizeActivePartialText()
			this.addCompletionResult(text)
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
			this.clineSdk?.stop({}).catch((error) => console.error(error))
		}, timeoutMs)
	}

	private clearPartialIdleWatchdog() {
		if (this.partialIdleTimer) {
			clearTimeout(this.partialIdleTimer)
			this.partialIdleTimer = null
		}
	}

	private noteTaskActivity(reason: string) {
		if (!this.state.currentTaskItem) {
			return
		}
		this.lastTaskActivityAt = Date.now()
		logInteraction("sidecar", "taskActivity", { reason })
		this.scheduleTaskIdleWatchdog()
	}

	private scheduleTaskIdleWatchdog() {
		this.clearTaskIdleWatchdog()
		if (!this.state.currentTaskItem) {
			return
		}
		const timeoutMs = readPositiveIntEnv("VSCLINE_TASK_IDLE_COMPLETE_MS", 180000)
		this.taskIdleTimer = setTimeout(() => {
			if (!this.state.currentTaskItem) {
				return
			}
			const idleForMs = Date.now() - this.lastTaskActivityAt
			if (idleForMs < timeoutMs - 1000) {
				this.scheduleTaskIdleWatchdog()
				return
			}

			logInteraction("sidecar", "taskIdleComplete", { timeoutMs, idleForMs })
			const activeText = this.getActivePartialText()
			this.finalizeActivePartialText()
			this.addCompletionResult(activeText || this.buildTerminalCompletionFallback("stalled"))
			const activeSessionId = this.clineSdk?.status.activeSessionId
			this.clineSdk?.stop({ sessionId: activeSessionId }).catch((error) => console.error(error))
			this.clineSdk?.markSessionInactive(activeSessionId || undefined)
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
		}, timeoutMs)
	}

	private clearTaskIdleWatchdog() {
		if (this.taskIdleTimer) {
			clearTimeout(this.taskIdleTimer)
			this.taskIdleTimer = null
		}
	}

	private shouldIgnoreSdkEvent(sessionId: string) {
		if (!sessionId) {
			return false
		}
		const activeSessionId = this.clineSdk?.status.activeSessionId
		if (activeSessionId) {
			return sessionId !== activeSessionId
		}
		return !this.state.currentTaskItem
	}

	private upsertMessage(ts: number, updates: Record<string, unknown>) {
		const index = this.state.clineMessages.findIndex((message) => message.ts === ts)
		if (index >= 0) {
			this.state.clineMessages[index] = normalizeClineMessagePayload({ ...this.state.clineMessages[index], ...updates, ts })
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
		this.taskSnapshots.set(String(this.state.currentTaskItem.id || ""), {
			taskItem: { ...this.state.currentTaskItem },
			messages: this.state.clineMessages.map((message) => ({ ...message })),
		})
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

	private async broadcastState() {
		const messages = this.buildStateMessages()
		logInteraction("sidecar->webview", "state.broadcast", { count: messages.length, messages })
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
		return [...this.stateStreamRequestIds].map((requestId) =>
			grpcResponse(requestId, { stateJson: JSON.stringify(this.state) }, true),
		)
	}

	private sendPartialMessage(message: Record<string, unknown> | undefined) {
		if (!message || this.partialMessageStreamRequestIds.size === 0) {
			return
		}

		for (const requestId of this.partialMessageStreamRequestIds) {
			logInteraction("sidecar->webview", "partialMessage", { requestId, message })
			sendHostRequest(
				this.connection,
				"webview.postMessage",
				{ message: grpcResponse(requestId, toProtoClineMessage(message), true) },
			).catch((error) => console.error(error))
		}
	}
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

function getNumber(message: unknown, key: string): number | undefined {
	const record = asRecord(message)
	const value = record[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function numberValue(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readPositiveIntEnv(name: string, fallback: number) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function readLoopDetectionConfig() {
	const raw = (process.env.VSCLINE_LOOP_DETECTION || "1").trim().toLowerCase()
	if (raw === "0" || raw === "false" || raw === "off") {
		return false
	}

	return {
		softThreshold: readPositiveIntEnv("VSCLINE_LOOP_SOFT_THRESHOLD", 3),
		hardThreshold: readPositiveIntEnv("VSCLINE_LOOP_HARD_THRESHOLD", 5),
	}
}

function isTerminalSdkStatus(status: string) {
	return status === "completed" || status === "stopped" || status === "cancelled" || status === "failed" || status === "error"
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
				const record = asRecord(item)
				return [getString(record, "command"), ...getStringArray(record, "args")].filter(Boolean).join(" ")
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
			const stdout = getString(result, "stdout")
			const stderr = getString(result, "stderr")
			const exitCode = result.exitCode
			const parts = [
				getString(record, "query"),
				typeof exitCode === "number" ? `exitCode=${exitCode}` : "",
				stdout ? `stdout:\n${stdout}` : "",
				stderr ? `stderr:\n${stderr}` : "",
			]
			return parts.filter(Boolean).join("\n")
		})
		.filter(Boolean)
		.join("\n\n")
	return summarized || text
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
	if (settings.enabled === true) {
		return true
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

function isJsonObjectString(value: string) {
	try {
		const parsed = JSON.parse(value)
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
	} catch {
		return false
	}
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
		...images.map((image) => `Image: ${image}`),
		...files.map((file) => `File: ${file}`),
	]
	return attachments.length > 0 ? `${text}\n\nAttachments:\n${attachments.join("\n")}` : text
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
	const usage = asRecord(metadata.usage || metadata.aggregateUsage)
	const checkpoint = asRecord(metadata.checkpoint)
	const latestCheckpoint = asRecord(checkpoint.latest)
	const id = getString(session, "sessionId") || getString(session, "id") || createId()
	const task = getString(metadata, "title") || getString(session, "title") || getString(session, "prompt") || "Cline SDK task"
	return {
		id,
		ts: getNumber(session, "updatedAt") || getNumber(session, "createdAt") || Date.now(),
		task,
		tokensIn: getNumber(usage, "inputTokens") || 0,
		tokensOut: getNumber(usage, "outputTokens") || 0,
		cacheWrites: getNumber(usage, "cacheWriteTokens") || 0,
		cacheReads: getNumber(usage, "cacheReadTokens") || 0,
		totalCost: getNumber(metadata, "totalCost") || getNumber(usage, "totalCost") || 0,
		isFavorited: metadata.isFavorited === true,
		size: getNumber(session, "messageCount") || 0,
		cwdOnTaskInitialization: getString(session, "cwd") || getString(metadata, "cwd") || process.cwd(),
		modelId: getString(metadata, "modelId") || getString(session, "modelId") || "",
		latestCheckpointRunCount: getNumber(latestCheckpoint, "runCount"),
	}
}

function sdkMessagesToClineMessages(messages: unknown, taskItem: Record<string, unknown>) {
	if (!Array.isArray(messages)) {
		return []
	}

	const result: Array<Record<string, unknown>> = []
	let sequence = 0
	for (const message of messages) {
		const record = asRecord(message)
		const role = getString(record, "role")
		const text = contentToText(record.content)
		const ts = Date.now() + sequence++
		if (role === "user") {
			result.push({ ts, type: "say", say: result.length === 0 ? "task" : "user_feedback", text })
		} else if (role === "assistant") {
			result.push({ ts, type: "say", say: "text", text })
		}

		const metadata = asRecord(record.metadata)
		const checkpointRunCount = getNumber(metadata, "checkpointRunCount")
		if (checkpointRunCount !== undefined) {
			result.push({
				ts: Date.now() + sequence++,
				type: "say",
				say: "checkpoint_created",
				text: "SDK checkpoint",
				checkpointRunCount,
				checkpointTaskItem: taskItem,
			})
		}
	}
	return result
}

function contentToText(content: unknown): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
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
			return `Tool: ${getString(record, "name")}\n${stringify(record.input)}`
		}
		if (type === "tool_result") {
			return `Tool result: ${contentToText(record.content)}`
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

function resolveApiKey(apiConfig: Record<string, unknown>, providerId: string) {
	const apiKeyFields: Record<string, string[]> = {
		anthropic: ["apiKey"],
		openrouter: ["openRouterApiKey"],
		openai: ["openAiApiKey", "openAiNativeApiKey"],
		"openai-compatible": ["openAiApiKey"],
		ollama: ["ollamaApiKey"],
		gemini: ["geminiApiKey"],
		requesty: ["requestyApiKey"],
		together: ["togetherApiKey"],
		fireworks: ["fireworksApiKey"],
		groq: ["groqApiKey"],
		litellm: ["liteLlmApiKey"],
		moonshot: ["moonshotApiKey"],
		deepseek: ["deepSeekApiKey"],
		qwen: ["qwenApiKey"],
		mistral: ["mistralApiKey"],
		xai: ["xaiApiKey"],
		baseten: ["basetenApiKey"],
		huggingface: ["huggingFaceApiKey"],
		"vercel-ai-gateway": ["vercelAiGatewayApiKey"],
		aihubmix: ["aihubmixApiKey"],
		hicap: ["hicapApiKey"],
		oca: ["ocaApiKey"],
	}

	for (const field of apiKeyFields[providerId] || []) {
		const value = getString(apiConfig, field)
		if (value) {
			return value
		}
	}

	return getString(apiConfig, "actModeOpenAiApiKey") || getString(apiConfig, "planModeOpenAiApiKey")
}

function resolveBaseUrl(apiConfig: Record<string, unknown>, providerId: string) {
	const baseUrlFields: Record<string, string> = {
		anthropic: "anthropicBaseUrl",
		openai: "openAiBaseUrl",
		"openai-compatible": "openAiBaseUrl",
		gemini: "geminiBaseUrl",
		ollama: "ollamaBaseUrl",
		lmstudio: "lmStudioBaseUrl",
		litellm: "liteLlmBaseUrl",
		requesty: "requestyBaseUrl",
		asksage: "asksageApiUrl",
		dify: "difyBaseUrl",
		oca: "ocaBaseUrl",
		aihubmix: "aihubmixBaseUrl",
	}

	return getString(apiConfig, baseUrlFields[providerId]) || getString(apiConfig, "actModeOpenAiBaseUrl")
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
			key.endsWith("ModelInfo") ||
			key.endsWith("ReasoningEffort") ||
			key.endsWith("ThinkingBudgetTokens") ||
			key === "openAiBaseUrl" ||
			key === "anthropicBaseUrl" ||
			key === "geminiBaseUrl" ||
			key === "requestTimeoutMs"
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

function createToolPolicies(autoApprovalSettings: unknown) {
	const settings = asRecord(autoApprovalSettings)
	const actions = asRecord(settings.actions)
	const autoApproveAll = settings.enabled === true
	const webFetchEnabled = process.env.VSCLINE_ENABLE_WEB_FETCH === "1"
	const readAuto = autoApproveAll || actions.readFiles === true
	const editAuto = autoApproveAll || actions.editFiles === true
	const commandAuto = autoApproveAll || actions.executeAllCommands === true || actions.executeSafeCommands === true
	const mcpAuto = autoApproveAll || actions.useMcp === true || actions.useMcpServers === true

	return {
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

	if (persisted.mode === "plan" || persisted.mode === "act") {
		state.mode = persisted.mode
	}
	if (typeof persisted.planActSeparateModelsSetting === "boolean") {
		state.planActSeparateModelsSetting = persisted.planActSeparateModelsSetting
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
					autoApprovalSettings: state.autoApprovalSettings,
					mode: state.mode,
					planActSeparateModelsSetting: state.planActSeparateModelsSetting,
				},
				null,
				2,
			),
			"utf8",
		)
	} catch (error) {
		console.error("Failed to persist Visual Studio Cline settings:", error)
	}
}

function clearPersistedState() {
	try {
		fs.rmSync(getSettingsPath(), { force: true })
	} catch {
		// Ignore cleanup failures; reset still applies to the in-memory state.
	}
}

function getSettingsPath() {
	const root =
		process.env.VSCLINE_SETTINGS_DIR ||
		path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Local"), "VsClineAgent")
	return path.join(root, "settings.json")
}

function normalizeOllamaRootBaseUrl(baseUrl: string) {
	return (baseUrl || "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/i, "")
}

function normalizeOllamaOpenAiBaseUrl(baseUrl: string) {
	return `${normalizeOllamaRootBaseUrl(baseUrl)}/v1`
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

function createInitialState() {
	const defaultProvider = process.env.CLINE_PROVIDER_ID || "ollama"
	const defaultModelId = process.env.CLINE_MODEL_ID || ""

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
		clineMessages: [] as Array<Record<string, unknown>>,
		taskHistory: [] as Array<Record<string, unknown>>,
		shouldShowAnnouncement: false,
		autoApprovalSettings: { version: 1, enabled: false, favorites: [], maxRequests: 20, actions: {} },
		browserSettings: { viewport: { width: 900, height: 600 }, remoteBrowserEnabled: false, disableToolUse: true },
		focusChainSettings: { enabled: false, remindClineInterval: 6 },
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
		customPrompt: null,
		useAutoCondense: false,
		subagentsEnabled: false,
		clineWebToolsEnabled: { user: false, featureFlag: false },
		worktreesEnabled: { user: false, featureFlag: false },
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
		hooksEnabled: false,
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
			{ id: "checkpoints", label: "Checkpoint restore", owner: "cline-sdk" },
			{ id: "usage", label: "Token and cost usage", owner: "cline-sdk" },
		],
		partial: [
			{ id: "mcp", label: "MCP servers and marketplace", owner: "cline-sdk" },
			{ id: "browser", label: "Browser/Web tools", owner: "cline-sdk" },
			{ id: "auth", label: "Cline account and OAuth providers", owner: "cline-sdk" },
			{ id: "models", label: "Provider catalog refresh", owner: "cline-sdk" },
			{ id: "subagents", label: "Subagents and teams", owner: "cline-sdk" },
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
