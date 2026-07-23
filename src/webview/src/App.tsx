import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { lazy, Suspense, useCallback, useEffect } from "react"
import ChatView from "./components/chat/ChatView"
import OnboardingView from "./components/onboarding/OnboardingView"
import LoadingScreen from "./components/welcome/LoadingScreen"
import BackgroundTaskStatus from "./components/common/BackgroundTaskStatus"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpcClient"
import { applyLigTheme, getLigTheme } from "./utils/ligTheme"
import { PLATFORM_CONFIG } from "./config/platform.config"

const AccountView = lazy(() => import("./components/account/AccountView"))
const HistoryView = lazy(() => import("./components/history/HistoryView"))
const McpView = lazy(() => import("./components/mcp/configuration/McpConfigurationView"))
const SettingsView = lazy(() => import("./components/settings/SettingsView"))
const WorktreesView = lazy(() => import("./components/worktrees/WorktreesView"))

const SecondaryViewFallback = () => (
	<div className="flex h-full w-full items-center justify-center" role="status">
		<span aria-label="Loading" className="codicon codicon-loading codicon-modifier-spin text-(--vscode-descriptionForeground)" />
	</div>
)

const AppContent = () => {
	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		closeMcpView,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		hideAnnouncement,
	} = useExtensionState()

	const { clineUser, organizations, activeOrganization } = useClineAuth()

	const showUpdateAnnouncementModal = useCallback(() => {
		setShowAnnouncement(true)
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error) => {
				console.error("Failed to acknowledge announcement:", error)
			})
	}, [setShouldShowAnnouncement, setShowAnnouncement])

	useEffect(() => {
		if (!didHydrateState || showWelcome || !shouldShowAnnouncement || showAnnouncement) {
			return
		}
		showUpdateAnnouncementModal()
	}, [didHydrateState, showWelcome, shouldShowAnnouncement, showAnnouncement, showUpdateAnnouncementModal])

	useEffect(() => {
		if (!didHydrateState) return
		PLATFORM_CONFIG.postMessage({
			protocol_version: 1,
			type: "vscline.webview.hydrated",
		})
	}, [didHydrateState])

	if (!didHydrateState) {
		return <LoadingScreen />
	}

	if (showWelcome) {
		return <OnboardingView />
	}

	return (
		<div className="flex h-screen w-full flex-col overflow-hidden">
			<BackgroundTaskStatus visible={showSettings || showHistory || showMcp || showAccount || showWorktrees} />
			<div className="relative min-h-0 flex-1 overflow-hidden">
				<Suspense fallback={<SecondaryViewFallback />}>
					{showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
					{showHistory && <HistoryView onDone={hideHistory} />}
					{showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
					{showAccount && <AccountView activeOrganization={activeOrganization} clineUser={clineUser} onDone={hideAccount} organizations={organizations} />}
					{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
				</Suspense>
				{/* Keep ChatView mounted so drafts and stream state survive secondary navigation. */}
				<ChatView hideAnnouncement={hideAnnouncement} isHidden={showSettings || showHistory || showMcp || showAccount || showWorktrees} showAnnouncement={showAnnouncement} showHistoryView={navigateToHistory} />
			</div>
		</div>
	)
}

const App = () => {
	useEffect(() => {
		applyLigTheme(getLigTheme())
	}, [])

	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
