import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { findLastIndex } from "@shared/array"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { Environment } from "@shared/configTypes"
import { DEFAULT_PLATFORM, type ClineMessage, type ExtensionState } from "@shared/ExtensionMessage"
import { DEFAULT_FOCUS_CHAIN_SETTINGS } from "@shared/FocusChainSettings"
import { DEFAULT_MCP_DISPLAY_MODE } from "@shared/McpDisplayMode"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { convertProtoToClineMessage } from "@shared/protoConversions/clineMessage"
import type React from "react"
import { createContext, useCallback, useContext, useMemo, useState } from "react"
import { useExtensionSubscriptions } from "./ExtensionSubscriptions"
import { useNavigationStateContext } from "./NavigationState"
import { useRuntimeViewStateContext } from "./RuntimeViewState"

export function mergeLivePartialMessages(prevState: ExtensionState, incomingState: ExtensionState): ExtensionState {
	const currentTaskId = prevState.currentTaskItem?.id
	const incomingTaskId = incomingState.currentTaskItem?.id
	if (!currentTaskId || currentTaskId !== incomingTaskId) {
		return incomingState
	}

	const incomingMessages = incomingState.clineMessages ?? []
	if (
		incomingMessages.some(
			(message) =>
				(message.type === "say" && (message.say === "completion_result" || message.say === "error")) ||
				(message.type === "ask" && message.ask === "completion_result"),
		)
	) {
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
		if (!previousMessage.ts) continue
		const incomingMessage = incomingByTs.get(previousMessage.ts)
		const isMissingAfterSnapshot =
			!incomingMessage &&
			(previousMessage.ts > latestIncomingTs || incomingMessages.length === 0 || incomingHasRegressedPartial)
		const isLongerLivePartial =
			incomingMessage?.partial === true &&
			previousMessage.partial === true &&
			(previousMessage.text?.length ?? 0) > (incomingMessage.text?.length ?? 0)
		if (isMissingAfterSnapshot || isLongerLivePartial) {
			mergedMessages = upsertMessageByTimestamp(mergedMessages, previousMessage)
		}
	}

	return mergedMessages === incomingMessages ? incomingState : { ...incomingState, clineMessages: mergedMessages }
}

function upsertMessageByTimestamp(messages: ClineMessage[], message: ClineMessage): ClineMessage[] {
	const index = messages.findIndex((item) => item.ts === message.ts)
	if (index < 0) return [...messages, message].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
	const next = [...messages]
	next[index] = message
	return next
}

function createInitialExtensionState(): ExtensionState {
	return {
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
		mcpResponsesCollapsed: false,
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
		workspaceRoots: [],
		primaryRootIndex: 0,
		isMultiRootWorkspace: false,
		multiRootSetting: { user: false, featureFlag: false },
		hooksEnabled: false,
		nativeToolCallSetting: false,
		enableParallelToolCalling: false,
	}
}

export interface TaskStreamState {
	state: ExtensionState
	setState: React.Dispatch<React.SetStateAction<ExtensionState>>
	didHydrateState: boolean
	onRelinquishControl: (callback: () => void) => () => void
}

const TaskStreamStateContext = createContext<TaskStreamState | undefined>(undefined)

export function TaskStreamStateProvider({ children }: { children: React.ReactNode }) {
	const navigation = useNavigationStateContext()
	const { setShowWelcome, setOnboardingModels, setAvailableTerminalProfiles } = useRuntimeViewStateContext()
	const [state, setState] = useState<ExtensionState>(createInitialExtensionState)
	const [didHydrateState, setDidHydrateState] = useState(false)

	const onStateJson = useCallback(
		(stateJson: string) => {
			try {
				const stateData = JSON.parse(stateJson) as ExtensionState
				setState((previousState) => {
					const incomingVersion = stateData.autoApprovalSettings?.version ?? 1
					const currentVersion = previousState.autoApprovalSettings?.version ?? 1
					const mergedState = mergeLivePartialMessages(previousState, stateData)
					const nextState = {
						...mergedState,
						uiLanguage:
							mergedState.uiLanguage === "en" || mergedState.uiLanguage === "ko"
								? mergedState.uiLanguage
								: mergedState.preferredLanguage === "English"
									? "en"
									: "ko",
						autoApprovalSettings:
							incomingVersion > currentVersion
								? mergedState.autoApprovalSettings
								: previousState.autoApprovalSettings,
					}
					const shouldShowWelcome = !nextState.welcomeViewCompleted
					setShowWelcome(shouldShowWelcome)
					setOnboardingModels(shouldShowWelcome ? nextState.onboardingModels : undefined)
					setDidHydrateState(true)
					return nextState
				})
			} catch (error) {
				console.error("Error parsing state JSON:", error)
			}
		},
		[setOnboardingModels, setShowWelcome],
	)

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
						clineMessages: [...previousState.clineMessages, partialMessage].sort(
							(a, b) => (a.ts ?? 0) - (b.ts ?? 0),
						),
					}
				}
				const existingMessage = previousState.clineMessages[lastIndex]
				if (
					existingMessage.partial === true &&
					partialMessage.partial === true &&
					(existingMessage.text?.length ?? 0) > (partialMessage.text?.length ?? 0)
				) {
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
		navigateToMcp: navigation.navigateToMcp,
		navigateToHistory: navigation.navigateToHistory,
		navigateToChat: navigation.navigateToChat,
		navigateToSettings: navigation.navigateToSettings,
		navigateToWorktrees: navigation.navigateToWorktrees,
		navigateToAccount: navigation.navigateToAccount,
	})

	const value = useMemo(
		() => ({ state, setState, didHydrateState, onRelinquishControl }),
		[state, didHydrateState, onRelinquishControl],
	)
	return <TaskStreamStateContext.Provider value={value}>{children}</TaskStreamStateContext.Provider>
}

export function useTaskStreamStateContext(): TaskStreamState {
	const context = useContext(TaskStreamStateContext)
	if (!context) throw new Error("useTaskStreamStateContext must be used within TaskStreamStateProvider")
	return context
}
