export type McpMutation =
	| "addRemoteServer"
	| "updateTimeout"
	| "restartServer"
	| "deleteServer"
	| "toggleToolAutoApprove"
	| "toggleServer"
	| "authenticateServer"

export type McpServerTargetRequest = Readonly<{ serverName: string }>
export type AddRemoteMcpServerRequest = Readonly<{ serverName: string; serverUrl: string; transportType: "sse" | "streamableHttp" }>
export type ToggleMcpServerRequest = Readonly<{ serverName: string; disabled: boolean }>
export type UpdateMcpTimeoutRequest = Readonly<{ serverName: string; timeout?: number }>
export type ToggleMcpToolRequest = Readonly<{ serverName: string; toolNames: string[]; autoApprove: boolean }>

export interface McpRuntimePort {
	getMcpServersResponse(): Promise<unknown>
	getMcpSettingsPath(): Promise<string>
	authenticateMcpServer(params: McpServerTargetRequest): Promise<unknown>
	addRemoteMcpServer(params: AddRemoteMcpServerRequest): Promise<unknown>
	setMcpServerDisabled(params: ToggleMcpServerRequest): Promise<unknown>
	updateMcpTimeout(params: UpdateMcpTimeoutRequest): Promise<unknown>
	deleteMcpServer(params: McpServerTargetRequest): Promise<unknown>
	restartMcpServer(params: McpServerTargetRequest): Promise<unknown>
	toggleMcpToolAutoApprove(params: ToggleMcpToolRequest): Promise<unknown>
}
