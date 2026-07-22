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
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react"
import { useExtensionSubscriptions } from "./ExtensionSubscriptions"
import { useNavigationStateContext } from "./NavigationState"
import { useRuntimeViewStateContext } from "./RuntimeViewState"
import { buildTaskMessageIndex, normalizeTaskStateMessages } from "./taskMessageNormalization"
import { mergeTaskPartial, TaskPartialBuffer } from "./taskPartialBuffer"

export function mergeLivePartialMessages(prevState: ExtensionState, incomingState: ExtensionState): ExtensionState {
	prevState = normalizeTaskStateMessages(prevState)
	incomingState = normalizeTaskStateMessages(incomingState)
	const currentTaskId = prevState.currentTaskItem?.id
	const incomingTaskId = incomingState.currentTaskItem?.id
	if (!currentTaskId || currentTaskId !== incomingTaskId) {
		return incomingState
	}

	const incomingMessages = incomingState.clineMessages ?? []
	const lastUserIndex = findLastIndex(
		incomingMessages,
		(message) => message.type === "say" && (message.say === "task" || message.say === "user_feedback"),
	)
	if (
		incomingMessages.slice(lastUserIndex + 1).some(
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
	const preserved: ClineMessage[] = []

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
			preserved.push(previousMessage)
		}
	}
	if (!preserved.length) return incomingState
	const mergedByTs = new Map(incomingMessages.map((message) => [message.ts, message]))
	for (const message of preserved) mergedByTs.set(message.ts, message)
	return { ...incomingState, clineMessages: [...mergedByTs.values()].sort(compareMessageTimestamp) }
}

function compareMessageTimestamp(left: ClineMessage, right: ClineMessage) { return (left.ts ?? 0) - (right.ts ?? 0) }
function createInitialExtensionState(): ExtensionState {
	return {
		version: "",
		clineMessages: [],
		taskLifecycleStatus: "idle",
		contextCompactionInProgress: false,
		contextCompactionThreshold: 90,
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
const LiveTaskMessagesContext = createContext<ClineMessage[] | undefined>(undefined)

export function TaskStreamStateProvider({ children }: { children: React.ReactNode }) {
	const navigation = useNavigationStateContext()
	const { setShowWelcome, setOnboardingModels, setAvailableTerminalProfiles } = useRuntimeViewStateContext()
	const [state, setState] = useState<ExtensionState>(createInitialExtensionState)
	const [liveMessages, setLiveMessages] = useState<ClineMessage[]>([])
	const liveMessagesRef = useRef<ClineMessage[]>([])
	const [didHydrateState, setDidHydrateState] = useState(false)
	const messageIndexRef = useRef(new Map<number, number>())
	const stateRef = useRef(state)
	const pendingPartialsRef = useRef(new TaskPartialBuffer())
	stateRef.current = state

	const onStateJson = useCallback(
		(stateJson: string) => {
			try {
				let stateData = normalizeTaskStateMessages(JSON.parse(stateJson) as ExtensionState)
				const incomingTaskId = String(stateData.currentTaskItem?.id || "")
				const buffered = pendingPartialsRef.current.take(incomingTaskId)
				if (buffered.length > 0) {
					let messages = stateData.clineMessages ?? []
					for (const proto of buffered) messages = mergeTaskPartial(messages, convertProtoToClineMessage(proto))
					stateData = { ...stateData, clineMessages: messages }
				}
				const previousState = { ...stateRef.current, clineMessages: liveMessagesRef.current }
				const incomingVersion = stateData.autoApprovalSettings?.version ?? 1
				const currentVersion = previousState.autoApprovalSettings?.version ?? 1
				const mergedState = mergeLivePartialMessages(previousState, stateData)
				const nextState = {
					...mergedState,
					uiLanguage: mergedState.uiLanguage === "en" || mergedState.uiLanguage === "ko"
						? mergedState.uiLanguage
						: mergedState.preferredLanguage === "English" ? "en" as const : "ko" as const,
					autoApprovalSettings: incomingVersion > currentVersion ? mergedState.autoApprovalSettings : previousState.autoApprovalSettings,
				}
				const shouldShowWelcome = !nextState.welcomeViewCompleted
				setShowWelcome(shouldShowWelcome)
				setOnboardingModels(shouldShowWelcome ? nextState.onboardingModels : undefined)
				setDidHydrateState(true)
				messageIndexRef.current = buildTaskMessageIndex(nextState.clineMessages)
				liveMessagesRef.current = nextState.clineMessages
				stateRef.current = nextState
				setLiveMessages(nextState.clineMessages)
				setState(nextState)
			} catch (error) {
				console.error("Error parsing state JSON:", error)
			}
		},
		[setOnboardingModels, setShowWelcome],
	)

	const onPartialMessage = useCallback((event: { taskId: string; message: ProtoClineMessage }) => {
		const protoMessage = event.message
		try {
			if (!event.taskId) return
			if (event.taskId !== String(stateRef.current.currentTaskItem?.id || "")) {
				pendingPartialsRef.current.add(event.taskId, protoMessage)
				return
			}
			if (!protoMessage.ts || protoMessage.ts <= 0) {
				console.error("Invalid timestamp in partial message:", protoMessage)
				return
			}
			const partialMessage = convertProtoToClineMessage(protoMessage)
			if (!partialMessage || typeof partialMessage !== "object") {
				console.error("Invalid partial message payload:", protoMessage)
				return
			}
			setLiveMessages((previousMessages) => {
				const clineMessages = mergeTaskPartial(previousMessages, partialMessage)
				if (clineMessages === previousMessages) return previousMessages
				messageIndexRef.current = buildTaskMessageIndex(clineMessages)
				liveMessagesRef.current = clineMessages
				return clineMessages
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
	return <TaskStreamStateContext.Provider value={value}><LiveTaskMessagesContext.Provider value={liveMessages}>{children}</LiveTaskMessagesContext.Provider></TaskStreamStateContext.Provider>
}

export function useTaskBaseStateContext(): TaskStreamState {
	const context = useContext(TaskStreamStateContext)
	if (!context) throw new Error("useTaskBaseStateContext must be used within TaskStreamStateProvider")
	return context
}

export function useLiveTaskMessages() {
	const messages = useContext(LiveTaskMessagesContext)
	if (!messages) throw new Error("useLiveTaskMessages must be used within TaskStreamStateProvider")
	return messages
}

export function useTaskStreamStateContext(): TaskStreamState {
	const base = useTaskBaseStateContext()
	const messages = useLiveTaskMessages()
	return useMemo(() => ({ ...base, state: { ...base.state, clineMessages: messages } }), [base, messages])
}
