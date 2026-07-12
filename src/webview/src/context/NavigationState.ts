import type { McpViewTab } from "@shared/mcp"
import { useCallback, useState } from "react"

export interface NavigationState {
	showMcp: boolean
	mcpTab?: McpViewTab
	showSettings: boolean
	settingsTargetSection?: string
	settingsInitialModelTab?: "recommended" | "free"
	showHistory: boolean
	showAccount: boolean
	showWorktrees: boolean
	showAnnouncement: boolean
	setShowMcp: (value: boolean) => void
	setMcpTab: (tab?: McpViewTab) => void
	setShowAnnouncement: (value: boolean) => void
	navigateToMcp: (tab?: McpViewTab) => void
	navigateToSettings: (targetSection?: string) => void
	navigateToSettingsModelPicker: (opts: { targetSection?: string; initialModelTab?: "recommended" | "free" }) => void
	navigateToHistory: () => void
	navigateToAccount: () => void
	navigateToWorktrees: () => void
	navigateToChat: () => void
	hideSettings: () => void
	hideHistory: () => void
	hideAccount: () => void
	hideWorktrees: () => void
	hideAnnouncement: () => void
	closeMcpView: () => void
}

export function useNavigationState(): NavigationState {
	const [showMcp, setShowMcp] = useState(false)
	const [mcpTab, setMcpTab] = useState<McpViewTab>()
	const [showSettings, setShowSettings] = useState(false)
	const [settingsTargetSection, setSettingsTargetSection] = useState<string>()
	const [settingsInitialModelTab, setSettingsInitialModelTab] = useState<"recommended" | "free">()
	const [showHistory, setShowHistory] = useState(false)
	const [showAccount, setShowAccount] = useState(false)
	const [showWorktrees, setShowWorktrees] = useState(false)
	const [showAnnouncement, setShowAnnouncement] = useState(false)

	const closeMcpView = useCallback(() => {
		setShowMcp(false)
		setMcpTab(undefined)
	}, [])
	const hideSettings = useCallback(() => {
		setShowSettings(false)
		setSettingsTargetSection(undefined)
		setSettingsInitialModelTab(undefined)
	}, [])
	const hideHistory = useCallback(() => setShowHistory(false), [])
	const hideAccount = useCallback(() => setShowAccount(false), [])
	const hideWorktrees = useCallback(() => setShowWorktrees(false), [])
	const hideAnnouncement = useCallback(() => setShowAnnouncement(false), [])
	const closePrimaryViews = useCallback(() => {
		setShowSettings(false)
		setShowHistory(false)
		setShowAccount(false)
		setShowWorktrees(false)
	}, [])

	const navigateToMcp = useCallback(
		(tab?: McpViewTab) => {
			closePrimaryViews()
			if (tab) {
				setMcpTab(tab)
			}
			setShowMcp(true)
		},
		[closePrimaryViews],
	)
	const navigateToSettingsModelPicker = useCallback(
		(opts: { targetSection?: string; initialModelTab?: "recommended" | "free" }) => {
			setShowHistory(false)
			closeMcpView()
			setShowAccount(false)
			setShowWorktrees(false)
			setSettingsTargetSection(opts.targetSection)
			setSettingsInitialModelTab(opts.initialModelTab)
			setShowSettings(true)
		},
		[closeMcpView],
	)
	const navigateToSettings = useCallback(
		(targetSection?: string) => navigateToSettingsModelPicker({ targetSection }),
		[navigateToSettingsModelPicker],
	)
	const navigateToHistory = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowAccount(false)
		setShowWorktrees(false)
		setShowHistory(true)
	}, [closeMcpView])
	const navigateToAccount = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowHistory(false)
		setShowWorktrees(false)
		setShowAccount(true)
	}, [closeMcpView])
	const navigateToWorktrees = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowHistory(false)
		setShowAccount(false)
		setShowWorktrees(true)
	}, [closeMcpView])
	const navigateToChat = useCallback(() => {
		closePrimaryViews()
		closeMcpView()
	}, [closePrimaryViews, closeMcpView])

	return {
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
	}
}
