export type ClineRuntimeStatus = {
	activeSessionId: string | null
	started?: boolean
	lastError?: string
}

export interface ClineRuntimePort {
	readonly status: ClineRuntimeStatus
	markSessionInactive(sessionId?: string): void
	activateSession(sessionId: string): Promise<any>
	startSession(params: unknown): Promise<any>
	send(params: unknown): Promise<any>
	stop(params: unknown): Promise<any>
	abort(params: unknown): Promise<any>
	listHistory(params: unknown): Promise<any>
	getSession(params: unknown): Promise<any>
	readMessages(params: unknown): Promise<any>
	deleteSession(params: unknown): Promise<any>
	updateSession(params: unknown): Promise<any>
	restore(params: unknown): Promise<any>
	listSettings(params: unknown): Promise<any>
	toggleSetting(params: unknown): Promise<any>
	getMcpServersResponse(): Promise<any>
	getMcpSettingsPath(): Promise<string>
	authenticateMcpServer(params: unknown): Promise<any>
	addRemoteMcpServer(params: unknown): Promise<any>
	setMcpServerDisabled(params: unknown): Promise<any>
	updateMcpTimeout(params: unknown): Promise<any>
	deleteMcpServer(params: unknown): Promise<any>
	restartMcpServer(params: unknown): Promise<any>
	toggleMcpToolAutoApprove(params: unknown): Promise<any>
	dispose(): Promise<void>
}
