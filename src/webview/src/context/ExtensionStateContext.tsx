import type { ExtensionState } from "@shared/ExtensionMessage"
import type { UserInfo } from "@shared/proto/cline/account"
import type React from "react"
import { createContext, useContext } from "react"
import { McpStateProvider, type McpState, useMcpStateContext } from "./McpState"
import { ModelCatalogStateProvider, type ModelCatalogState } from "./ModelCatalogState"
import { NavigationStateProvider, type NavigationState, useNavigationStateContext } from "./NavigationState"
import { RuntimeViewStateProvider, type RuntimeViewState, useRuntimeViewStateContext } from "./RuntimeViewState"
import { TaskStreamStateProvider, useTaskStreamStateContext } from "./TaskStreamState"

export { mergeLivePartialMessages } from "./TaskStreamState"

export interface ExtensionStateContextType extends ExtensionState, NavigationState, ModelCatalogState, McpState, RuntimeViewState {
	didHydrateState: boolean
	lastDismissedCliBannerVersion: number
	dismissedBanners?: Array<{ bannerId: string; dismissedAt: number }>

	// Setters
	setShouldShowAnnouncement: (value: boolean) => void
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
	setUserInfo: (userInfo?: UserInfo) => void

	// Event callbacks
	onRelinquishControl: (callback: () => void) => () => void
}

export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

const ExtensionStateContextBridge: React.FC<{
	children: React.ReactNode
}> = ({ children }) => {
	const navigation = useNavigationStateContext()
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

	const mcpState = useMcpStateContext()
	const runtimeViewState = useRuntimeViewStateContext()
	const { state, setState, didHydrateState, onRelinquishControl } = useTaskStreamStateContext()

	const createContextValue = (modelCatalog: ModelCatalogState): ExtensionStateContextType => ({
		...state,
		...modelCatalog,
		...mcpState,
		...runtimeViewState,
		didHydrateState,
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
		setShouldShowAnnouncement: (value) =>
			setState((prevState) => ({
				...prevState,
				shouldShowAnnouncement: value,
			})),
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
		onRelinquishControl,
		setUserInfo: (userInfo?: UserInfo) => setState((prevState) => ({ ...prevState, userInfo })),
	})

	return (
		<ModelCatalogStateProvider apiConfiguration={state.apiConfiguration}>
			{(modelCatalog) => (
				<ExtensionStateContext.Provider value={createContextValue(modelCatalog)}>
					{children}
				</ExtensionStateContext.Provider>
			)}
		</ModelCatalogStateProvider>
	)
}

export const ExtensionStateContextProvider: React.FC<{
	children: React.ReactNode
}> = ({ children }) => (
	<NavigationStateProvider>
		<McpStateProvider>
			<RuntimeViewStateProvider>
				<TaskStreamStateProvider>
					<ExtensionStateContextBridge>{children}</ExtensionStateContextBridge>
				</TaskStreamStateProvider>
			</RuntimeViewStateProvider>
		</McpStateProvider>
	</NavigationStateProvider>
)

export const useExtensionState = () => {
	const context = useContext(ExtensionStateContext)
	if (context === undefined) {
		throw new Error("useExtensionState must be used within an ExtensionStateContextProvider")
	}
	return context
}
