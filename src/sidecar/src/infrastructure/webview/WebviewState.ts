import type { TaskLifecycleStatus } from "../../domain/task/TaskLifecycle"
import { capabilityRegistry } from "../../application/services/CapabilityRegistry"
import { normalizeClineMessagePayload, normalizeMcpDisplayMode } from "../conversation/ConversationMessageProjection"
import { projectTranscriptMessages, TRANSCRIPT_SNAPSHOT_LIMITS } from "../conversation/TranscriptSnapshotPolicy"
import {
	isWebFetchEnabled,
	normalizeApiConfiguration,
	normalizeApiConfigurationProfiles,
	normalizePreferredLanguage,
	resolveOAuthCredentials,
	webFetchDisabledReason,
} from "../configuration/ProviderConfiguration"

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(asRecord) : []
}

function getString(record: Record<string, unknown>, key: string): string {
	return typeof record[key] === "string" ? String(record[key]) : ""
}

export function cloneTaskSnapshot(snapshot: unknown): { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null {
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

export function loadInitialState(persisted: Record<string, unknown> | null) {
	const state = createInitialState()
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
	if (typeof persisted.contextCompactionThreshold === "number" && Number.isFinite(persisted.contextCompactionThreshold)) {
		state.contextCompactionThreshold = Math.min(100, Math.max(1, persisted.contextCompactionThreshold))
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

export function createPersistedStateSnapshot(state: ReturnType<typeof createInitialState>): Record<string, unknown> {
	return {
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
		contextCompactionThreshold: state.contextCompactionThreshold,
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
	}
}

export function createWebviewStateSnapshot(state: ReturnType<typeof createInitialState>) {
	const { taskSnapshots: _taskSnapshots, ...webviewState } = state
	return {
		...webviewState,
		clineMessages: projectTranscriptMessages(state.clineMessages, TRANSCRIPT_SNAPSHOT_LIMITS.currentMessages),
	}
}

export function createMcpServersLazyResponse() {
	return {
		mcpServers: [],
		reduced: true,
		reason: "mcp_servers_lazy_loaded",
		message: "MCP servers are loaded when the MCP view is opened.",
	}
}

export function createInitialState() {
	const defaultProvider = process.env.CLINE_PROVIDER_ID || "ollama"
	const defaultModelId = process.env.CLINE_MODEL_ID || ""
	const browserSettings = { viewport: { width: 900, height: 600 }, remoteBrowserEnabled: false, disableToolUse: false }
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
		taskLifecycleStatus: "idle" as TaskLifecycleStatus,
		contextCompactionInProgress: false,
		contextCompactionThreshold: 90,
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
		hooksEnabled: false,
		nativeToolCallSetting: false,
		enableParallelToolCalling: false,
		currentTaskItem: null as Record<string, unknown> | null,
	}
}

export function createSdkCoverageState(lastError: string | null) {
	return {
		mode: "sdk-wrapper",
		sdkPackage: "@cline/sdk",
		sdkVersion: readBundledSdkVersion(),
		status: lastError ? "error" : "ready",
		lastError: lastError || undefined,
		...capabilityRegistry.coverage(),
	}
}

export function readBundledSdkVersion() {
	return "0.0.42"
}
