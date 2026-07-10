export interface WebviewMessagePort {
	dispose(): void
	handle(params: unknown): Promise<unknown>
}

export interface SidecarRuntimeControlPort {
	readonly status: unknown
	ensureStarted(): Promise<unknown>
	startSession(params: unknown): Promise<unknown>
	send(params: unknown): Promise<unknown>
	stop(params: unknown): Promise<unknown>
	listHistory(params: unknown): Promise<unknown>
	getSession(params: unknown): Promise<unknown>
	readMessages(params: unknown): Promise<unknown>
	deleteSession(params: unknown): Promise<unknown>
	updateSession(params: unknown): Promise<unknown>
	getUsage(params: unknown): Promise<unknown>
	restore(params: unknown): Promise<unknown>
	listSettings(params: unknown): Promise<unknown>
	toggleSetting(params: unknown): Promise<unknown>
	dispose(): Promise<void>
}

export interface SidecarConnectionScope {
	readonly runtime: SidecarRuntimeControlPort
	readonly webview: WebviewMessagePort
	roundtrip(): Promise<unknown>
}
