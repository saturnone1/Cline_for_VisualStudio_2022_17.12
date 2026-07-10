export type McpMutation =
	| "addRemoteServer"
	| "updateTimeout"
	| "restartServer"
	| "deleteServer"
	| "toggleToolAutoApprove"
	| "toggleServer"
	| "authenticateServer"

export interface McpRuntimePort {
	getMcpServersResponse(): Promise<unknown>
	getMcpSettingsPath(): Promise<string>
	authenticateMcpServer(params: Record<string, unknown>): Promise<unknown>
	addRemoteMcpServer(params: Record<string, unknown>): Promise<unknown>
	setMcpServerDisabled(params: Record<string, unknown>): Promise<unknown>
	updateMcpTimeout(params: Record<string, unknown>): Promise<unknown>
	deleteMcpServer(params: Record<string, unknown>): Promise<unknown>
	restartMcpServer(params: Record<string, unknown>): Promise<unknown>
	toggleMcpToolAutoApprove(params: Record<string, unknown>): Promise<unknown>
}
