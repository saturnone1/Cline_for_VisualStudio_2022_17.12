export type AgentMessageRequest = Readonly<{
	sessionId: string
	prompt: string
	mode?: "plan" | "act"
	delivery?: "queue" | "steer"
	userImages?: readonly string[]
	userFiles?: readonly string[]
}>

export type AgentStartRequest = Readonly<{
	prompt: string
	cwd: string
	sessionId?: string
	providerId?: string
	modelId?: string
	apiKey?: string
	systemPrompt?: string
	mode?: "plan" | "act"
	interactive?: boolean
	userImages?: readonly string[]
	userFiles?: readonly string[]
	initialMessages?: readonly unknown[]
	sessionMetadata?: Readonly<Record<string, unknown>>
	config?: Readonly<Record<string, unknown>>
	toolPolicies?: Readonly<Record<string, unknown>>
}>

export type AgentSessionRequest = Readonly<{ sessionId: string }>
export type AgentCompactSessionRequest = Readonly<{
	sourceSessionId: string
	cwd: string
	initialMessages: readonly unknown[]
	sessionMetadata?: Readonly<Record<string, unknown>>
	config: Readonly<Record<string, unknown>>
	toolPolicies?: Readonly<Record<string, unknown>>
	signal?: AbortSignal
}>
export type AgentRestoreRequest = Readonly<{
	sessionId: string
	checkpointRunCount: number
	cwd: string
	restore: Readonly<{ messages: boolean; workspace: boolean }>
	start: Readonly<{ config: Readonly<Record<string, unknown>>; interactive: boolean; toolPolicies: Readonly<Record<string, unknown>> }>
}>

export type AgentEngineStatus = {
	activeSessionId: string | null
	started?: boolean
	lastError?: string
}

// Product features depend on this boundary. Cline SDK types must remain inside
// the infrastructure adapter that implements it.
export interface AgentEnginePort {
	readonly status: AgentEngineStatus
	markSessionInactive(sessionId?: string): void
	activateSession(sessionId: string): Promise<unknown>
	startSession(command: AgentStartRequest): Promise<unknown>
	compactSession(command: AgentCompactSessionRequest): Promise<unknown>
	send(command: AgentMessageRequest): Promise<unknown>
	stop(command: AgentSessionRequest): Promise<unknown>
	abort(command: AgentSessionRequest): Promise<unknown>
	listHistory(params: unknown): Promise<unknown>
	getSession(params: unknown): Promise<unknown>
	readMessages(params: unknown): Promise<unknown>
	deleteSession(params: unknown): Promise<unknown>
	updateSession(params: unknown): Promise<unknown>
	restore(params: AgentRestoreRequest): Promise<unknown>
	listSettings(params: unknown): Promise<unknown>
	toggleSetting(params: unknown): Promise<unknown>
	getProviderConfigFields(providerId: string): Promise<unknown>
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
