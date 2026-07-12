import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { findLastIndex } from "@shared/array"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { DEFAULT_PLATFORM, type ClineMessage, type ExtensionState } from "@shared/ExtensionMessage"
import { DEFAULT_FOCUS_CHAIN_SETTINGS } from "@shared/FocusChainSettings"
import { DEFAULT_MCP_DISPLAY_MODE } from "@shared/McpDisplayMode"
import type { UserInfo } from "@shared/proto/cline/account"
import { OnboardingModelGroup, type TerminalProfile } from "@shared/proto/cline/state"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { convertProtoToClineMessage } from "@shared/protoConversions/clineMessage"
import type React from "react"
import { createContext, useCallback, useContext, useState } from "react"
import { Environment } from "@shared/configTypes"
import type { McpMarketplaceCatalog, McpServer } from "@shared/mcp"
import { useExtensionSubscriptions } from "./ExtensionSubscriptions"
import { useModelCatalogState, type ModelCatalogState } from "./ModelCatalogState"
import { useNavigationState, type NavigationState } from "./NavigationState"

export function mergeLivePartialMessages(prevState: ExtensionState, incomingState: ExtensionState): ExtensionState {
	const currentTaskId = prevState.currentTaskItem?.id
	const incomingTaskId = incomingState.currentTaskItem?.id
	if (!currentTaskId || currentTaskId !== incomingTaskId) {
		return incomingState
	}

	const incomingMessages = incomingState.clineMessages ?? []
	const incomingHasTerminalMessage = incomingMessages.some(
		(message) =>
			(message.type === "say" && (message.say === "completion_result" || message.say === "error")) ||
			(message.type === "ask" && message.ask === "completion_result"),
	)
	if (incomingHasTerminalMessage) {
		return incomingState
	}

	const incomingByTs = new Map(incomingMessages.map((message) => [message.ts, message]))
	const latestIncomingTs = incomingMessages.reduce((latest, message) => Math.max(latest, message.ts ?? 0), 0)
	const incomingHasRegressedPartial = (prevState.clineMessages ?? []).some((previousMessage) => {
		const incomingMessage = incomingByTs.get(previousMessage.ts)
		return (
			previousMessage.partial === true &&
			incomingMessage?.partial === true &&
			(previousMessage.text?.length ?? 0) > (incomingMessage.text?.length ?? 0)
		)
	})
	let mergedMessages = incomingMessages

	for (const previousMessage of prevState.clineMessages ?? []) {
		if (!previousMessage.ts) {
			continue
		}

		const incomingMessage = incomingByTs.get(previousMessage.ts)
		const previousTextLength = previousMessage.text?.length ?? 0
		const incomingTextLength = incomingMessage?.text?.length ?? 0
		const isNewerThanSnapshot = !incomingMessage && previousMessage.ts > latestIncomingTs
		const isMissingFromEmptySnapshot = !incomingMessage && incomingMessages.length === 0
		const isMissingFromRegressedSnapshot = !incomingMessage && incomingHasRegressedPartial
		const isLongerLivePartial = incomingMessage?.partial === true && previousMessage.partial === true && previousTextLength > incomingTextLength
		if (isNewerThanSnapshot || isMissingFromEmptySnapshot || isMissingFromRegressedSnapshot || isLongerLivePartial) {
			mergedMessages = upsertMessageByTimestamp(mergedMessages, previousMessage)
		}
	}

	return mergedMessages === incomingMessages
		? incomingState
		: {
			...incomingState,
			clineMessages: mergedMessages,
		}
}

function upsertMessageByTimestamp(messages: ClineMessage[], message: ClineMessage): ClineMessage[] {
	const index = messages.findIndex((item) => item.ts === message.ts)
	if (index >= 0) {
		const next = [...messages]
		next[index] = message
		return next
	}

	return [...messages, message].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
}

export interface ExtensionStateContextType extends ExtensionState, NavigationState, ModelCatalogState {
	didHydrateState: boolean
	showWelcome: boolean
	onboardingModels: OnboardingModelGroup | undefined
	mcpServers: McpServer[]
	mcpMarketplaceCatalog: McpMarketplaceCatalog
	totalTasksSize: number | null
	lastDismissedCliBannerVersion: number
	dismissedBanners?: Array<{ bannerId: string; dismissedAt: number }>

	availableTerminalProfiles: TerminalProfile[]

	// View state
	expandTaskHeader: boolean

	// Setters
	setShouldShowAnnouncement: (value: boolean) => void
	setMcpServers: (value: McpServer[]) => void
	setGlobalClineRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalClineRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalCursorRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWindsurfRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalAgentsRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalSkillsToggles: (toggles: Record<string, boolean>) => void
	setLocalSkillsToggles: (toggles: Record<string, boolean>) => void
	setRemoteRulesToggles: (toggles: Record<string, boolean>) => void
	setRemoteWorkflowToggles: (toggles: Record<string, boolean>) => void
	setMcpMarketplaceCatalog: (value: McpMarketplaceCatalog) => void
	setTotalTasksSize: (value: number | null) => void
	setExpandTaskHeader: (value: boolean) => void
	setShowWelcome: (value: boolean) => void
	setOnboardingModels: (value: OnboardingModelGroup | undefined) => void

	setUserInfo: (userInfo?: UserInfo) => void

	// Event callbacks
	onRelinquishControl: (callback: () => void) => () => void
}

export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

export const ExtensionStateContextProvider: React.FC<{
	children: React.ReactNode
}> = ({ children }) => {
	const navigation = useNavigationState()
	const {
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		settingsInitialModelTab,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		setShowMcp,
		setMcpTab,
		setShowAnnouncement,
		navigateToMcp,
		navigateToSettings,
		navigateToSettingsModelPicker,
		navigateToHistory,
		navigateToAccount,
		navigateToWorktrees,
		navigateToChat,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		hideAnnouncement,
		closeMcpView,
	} = navigation

	const [state, setState] = useState<ExtensionState>({
		version: "",
		clineMessages: [],
		taskHistory: [],
		shouldShowAnnouncement: false,
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
		browserSettings: DEFAULT_BROWSER_SETTINGS,
		focusChainSettings: DEFAULT_FOCUS_CHAIN_SETTINGS,
		uiLanguage: "ko",
		preferredLanguage: "English",
		mode: "act",
		platform: DEFAULT_PLATFORM,
		environment: Environment.production,
		telemetrySetting: "unset",
		distinctId: "",
		planActSeparateModelsSetting: true,
		apiConfigurationProfiles: [],
		activeApiConfigurationProfileId: undefined,
		enableCheckpointsSetting: true,
		mcpDisplayMode: DEFAULT_MCP_DISPLAY_MODE,
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
		defaultTerminalProfile: "default",
		isNewUser: false,
		welcomeViewCompleted: false,
		onboardingModels: undefined,
		mcpResponsesCollapsed: false, // Default value (expanded), will be overwritten by extension state
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		customPrompt: "",
		useAutoCondense: false,
		subagentsEnabled: false,
		scheduledAgentsEnabled: false,
		clineWebToolsEnabled: { user: true, featureFlag: false },
		worktreesEnabled: { user: true, featureFlag: false },
		favoritedModelIds: [],
		lastDismissedInfoBannerVersion: 0,
		lastDismissedModelBannerVersion: 0,
		optOutOfRemoteConfig: false,
		remoteConfigSettings: {},
		backgroundCommandRunning: false,
		backgroundCommandTaskId: undefined,
		lastDismissedCliBannerVersion: 0,
		backgroundEditEnabled: false,
		doubleCheckCompletionEnabled: false,
		lazyTeammateModeEnabled: false,
		showFeatureTips: true,
		globalSkillsToggles: {},
		localSkillsToggles: {},

		// NEW: Add workspace information with defaults
		workspaceRoots: [],
		primaryRootIndex: 0,
		isMultiRootWorkspace: false,
		multiRootSetting: { user: false, featureFlag: false },
		hooksEnabled: false,
		nativeToolCallSetting: false,
		enableParallelToolCalling: false,
	})
	const modelCatalog = useModelCatalogState(state.apiConfiguration)
	const [expandTaskHeader, setExpandTaskHeader] = useState(true)
	const [didHydrateState, setDidHydrateState] = useState(false)

	const [showWelcome, setShowWelcome] = useState(false)
	const [onboardingModels, setOnboardingModels] = useState<OnboardingModelGroup | undefined>(undefined)
	const [totalTasksSize, setTotalTasksSize] = useState<number | null>(null)
	const [availableTerminalProfiles, setAvailableTerminalProfiles] = useState<TerminalProfile[]>([])
	const [mcpServers, setMcpServers] = useState<McpServer[]>([])
	const [mcpMarketplaceCatalog, setMcpMarketplaceCatalog] = useState<McpMarketplaceCatalog>({ items: [] })

	const onStateJson = useCallback((stateJson: string) => {
		try {
			const stateData = JSON.parse(stateJson) as ExtensionState
			setState((previousState) => {
				const incomingVersion = stateData.autoApprovalSettings?.version ?? 1
				const currentVersion = previousState.autoApprovalSettings?.version ?? 1
				const mergedState = mergeLivePartialMessages(previousState, stateData)
				const newState = {
					...mergedState,
					uiLanguage:
						mergedState.uiLanguage === "en" || mergedState.uiLanguage === "ko"
							? mergedState.uiLanguage
							: mergedState.preferredLanguage === "English"
								? "en"
								: "ko",
					autoApprovalSettings:
						incomingVersion > currentVersion ? mergedState.autoApprovalSettings : previousState.autoApprovalSettings,
				}

				const shouldShowWelcome = !newState.welcomeViewCompleted
				setShowWelcome(shouldShowWelcome)
				setOnboardingModels(shouldShowWelcome ? newState.onboardingModels : undefined)
				setDidHydrateState(true)
				return newState
			})
		} catch (error) {
			console.error("Error parsing state JSON:", error)
		}
	}, [])

	const onPartialMessage = useCallback((protoMessage: ProtoClineMessage) => {
		try {
			if (!protoMessage.ts || protoMessage.ts <= 0) {
				console.error("Invalid timestamp in partial message:", protoMessage)
				return
			}

			const partialMessage = convertProtoToClineMessage(protoMessage)
			setState((previousState) => {
				const lastIndex = findLastIndex(previousState.clineMessages, (message) => message.ts === partialMessage.ts)
				if (lastIndex === -1) {
					return {
						...previousState,
						clineMessages: [...previousState.clineMessages, partialMessage].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)),
					}
				}

				const existingMessage = previousState.clineMessages[lastIndex]
				const existingTextLength = existingMessage.text?.length ?? 0
				const incomingTextLength = partialMessage.text?.length ?? 0
				if (existingMessage.partial === true && partialMessage.partial === true && existingTextLength > incomingTextLength) {
					return previousState
				}

				const clineMessages = [...previousState.clineMessages]
				clineMessages[lastIndex] = partialMessage
				return { ...previousState, clineMessages }
			})
		} catch (error) {
			console.error("Failed to process partial message:", error, protoMessage)
		}
	}, [])

	const { onRelinquishControl } = useExtensionSubscriptions({
		onStateJson,
		onPartialMessage,
		onTerminalProfiles: setAvailableTerminalProfiles,
		navigateToMcp,
		navigateToHistory,
		navigateToChat,
		navigateToSettings,
		navigateToWorktrees,
		navigateToAccount,
	})

	const contextValue: ExtensionStateContextType = {
		...state,
		...modelCatalog,
		didHydrateState,
		showWelcome,
		onboardingModels,
		mcpServers,
		mcpMarketplaceCatalog,
		totalTasksSize,
		availableTerminalProfiles,
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		settingsInitialModelTab,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		globalClineRulesToggles: state.globalClineRulesToggles || {},
		localClineRulesToggles: state.localClineRulesToggles || {},
		localCursorRulesToggles: state.localCursorRulesToggles || {},
		localWindsurfRulesToggles: state.localWindsurfRulesToggles || {},
		localAgentsRulesToggles: state.localAgentsRulesToggles || {},
		localWorkflowToggles: state.localWorkflowToggles || {},
		globalWorkflowToggles: state.globalWorkflowToggles || {},
		remoteRulesToggles: state.remoteRulesToggles || {},
		remoteWorkflowToggles: state.remoteWorkflowToggles || {},
		enableCheckpointsSetting: state.enableCheckpointsSetting,
		currentFocusChainChecklist: state.currentFocusChainChecklist,

		// Navigation functions
		navigateToMcp,
		navigateToSettings,
		navigateToSettingsModelPicker,
		navigateToHistory,
		navigateToAccount,
		navigateToWorktrees,
		navigateToChat,

		// Hide functions
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		hideAnnouncement,
		setShowAnnouncement,
		setShowWelcome,
		setOnboardingModels,
		setShouldShowAnnouncement: (value) =>
			setState((prevState) => ({
				...prevState,
				shouldShowAnnouncement: value,
			})),
		setMcpServers,
		setMcpMarketplaceCatalog,
		setShowMcp,
		closeMcpView,
		setGlobalClineRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				globalClineRulesToggles: toggles,
			})),
		setLocalClineRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localClineRulesToggles: toggles,
			})),
		setLocalCursorRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localCursorRulesToggles: toggles,
			})),
		setLocalWindsurfRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localWindsurfRulesToggles: toggles,
			})),
		setLocalAgentsRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localAgentsRulesToggles: toggles,
			})),
		setLocalWorkflowToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localWorkflowToggles: toggles,
			})),
		setGlobalWorkflowToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				globalWorkflowToggles: toggles,
			})),
		setGlobalSkillsToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				globalSkillsToggles: toggles,
			})),
		setLocalSkillsToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localSkillsToggles: toggles,
			})),
		setRemoteRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				remoteRulesToggles: toggles,
			})),
		setRemoteWorkflowToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				remoteWorkflowToggles: toggles,
			})),
		setMcpTab,
		setTotalTasksSize,
		onRelinquishControl,
		setUserInfo: (userInfo?: UserInfo) => setState((prevState) => ({ ...prevState, userInfo })),
		expandTaskHeader,
		setExpandTaskHeader,
	}

	return <ExtensionStateContext.Provider value={contextValue}>{children}</ExtensionStateContext.Provider>
}

export const useExtensionState = () => {
	const context = useContext(ExtensionStateContext)
	if (context === undefined) {
		throw new Error("useExtensionState must be used within an ExtensionStateContextProvider")
	}
	return context
}
