export type ClineRuntimeStatus = {
	activeSessionId: string | null
	started?: boolean
	lastError?: string
}

export interface ClineRuntimePort {
	readonly status: ClineRuntimeStatus
	markSessionInactive(sessionId?: string): void
	activateSession(sessionId: string): Promise<unknown>
	startSession(params: unknown): Promise<unknown>
	send(params: unknown): Promise<unknown>
	stop(params: unknown): Promise<unknown>
	abort(params: unknown): Promise<unknown>
	listHistory(params: unknown): Promise<unknown>
	getSession(params: unknown): Promise<unknown>
	readMessages(params: unknown): Promise<unknown>
	deleteSession(params: unknown): Promise<unknown>
	updateSession(params: unknown): Promise<unknown>
	restore(params: unknown): Promise<unknown>
	listSettings(params: unknown): Promise<unknown>
	toggleSetting(params: unknown): Promise<unknown>
	getMcpServersResponse(): Promise<unknown>
	getMcpSettingsPath(): Promise<string>
	authenticateMcpServer(params: unknown): Promise<unknown>
	addRemoteMcpServer(params: unknown): Promise<unknown>
	setMcpServerDisabled(params: unknown): Promise<unknown>
	updateMcpTimeout(params: unknown): Promise<unknown>
	deleteMcpServer(params: unknown): Promise<unknown>
	restartMcpServer(params: unknown): Promise<unknown>
	toggleMcpToolAutoApprove(params: unknown): Promise<unknown>
	dispose(): Promise<void>
}
