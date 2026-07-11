import { createProtoStub } from "../protoStub"

export type AddRemoteMcpServerRequest = { serverName: string; serverUrl: string; transportType: string }
export const AddRemoteMcpServerRequest = createProtoStub<AddRemoteMcpServerRequest>("AddRemoteMcpServerRequest")

export type McpPrompt = { name: string; title?: string; description?: string; arguments: McpPromptArgument[] }
export const McpPrompt = createProtoStub<McpPrompt>("McpPrompt")

export type McpPromptArgument = { name: string; description?: string; required?: boolean }
export const McpPromptArgument = createProtoStub<McpPromptArgument>("McpPromptArgument")

export type McpResource = { uri: string; name: string; mimeType?: string; description?: string }
export const McpResource = createProtoStub<McpResource>("McpResource")

export type McpResourceTemplate = { uriTemplate: string; name: string; description?: string; mimeType?: string }
export const McpResourceTemplate = createProtoStub<McpResourceTemplate>("McpResourceTemplate")

export type McpServer = {
	name: string
	config: string
	status: McpServerStatus
	error?: string
	tools: McpTool[]
	resources: McpResource[]
	resourceTemplates: McpResourceTemplate[]
	prompts: McpPrompt[]
	disabled?: boolean
	timeout?: number
	oauthRequired?: boolean
	oauthAuthStatus?: string
}
export const McpServer = createProtoStub<McpServer>("McpServer")

export type McpServerStatus =
	| "MCP_SERVER_STATUS_UNSPECIFIED"
	| "MCP_SERVER_STATUS_CONNECTED"
	| "MCP_SERVER_STATUS_CONNECTING"
	| "MCP_SERVER_STATUS_DISCONNECTED"
export const McpServerStatus = {
	MCP_SERVER_STATUS_UNSPECIFIED: "MCP_SERVER_STATUS_UNSPECIFIED",
	MCP_SERVER_STATUS_CONNECTED: "MCP_SERVER_STATUS_CONNECTED",
	MCP_SERVER_STATUS_CONNECTING: "MCP_SERVER_STATUS_CONNECTING",
	MCP_SERVER_STATUS_DISCONNECTED: "MCP_SERVER_STATUS_DISCONNECTED",
} as const satisfies Record<string, McpServerStatus>

export type McpServers = { mcpServers: McpServer[] }
export const McpServers = createProtoStub<McpServers>("McpServers")

export type McpTool = { name: string; description?: string; inputSchema?: string; autoApprove?: boolean }
export const McpTool = createProtoStub<McpTool>("McpTool")

export type ToggleMcpServerRequest = { serverName: string; disabled: boolean }
export const ToggleMcpServerRequest = createProtoStub<ToggleMcpServerRequest>("ToggleMcpServerRequest")

export type ToggleToolAutoApproveRequest = { serverName: string; toolNames: string[]; autoApprove: boolean }
export const ToggleToolAutoApproveRequest = createProtoStub<ToggleToolAutoApproveRequest>("ToggleToolAutoApproveRequest")

export type UpdateMcpTimeoutRequest = { serverName: string; timeout: number }
export const UpdateMcpTimeoutRequest = createProtoStub<UpdateMcpTimeoutRequest>("UpdateMcpTimeoutRequest")
