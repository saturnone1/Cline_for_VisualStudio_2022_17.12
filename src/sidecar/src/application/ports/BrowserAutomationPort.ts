export type BrowserViewport = { width: number; height: number }
export type BrowserAction = { action: string; url?: string; tabId?: string; browserSessionId?: string; browserActionId?: string; coordinate?: string; text?: string; viewport: BrowserViewport; onPhase?: (phase: Record<string, unknown>) => void }

export type BrowserDebugInfo = Readonly<{
	success?: boolean
	host?: string
	browser?: string
	protocolVersion?: string
	tabCount?: number
	activeTabTitle?: string
	activeTabUrl?: string
	error?: string
}>

export interface BrowserAutomationPort {
	resolveExecutablePath(configuredPath?: string): string
	ensureAvailable(host: string, executablePath: string): Promise<BrowserDebugInfo>
	fetchDebugInfo(host: string): Promise<BrowserDebugInfo>
	listTabs(host: string): Promise<unknown>
	runAction(host: string, request: BrowserAction): Promise<unknown>
	cancelActive(): Promise<number>
}
