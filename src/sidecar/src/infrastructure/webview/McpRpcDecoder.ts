import type { McpCommand } from "../../features/mcp/McpRpcHandler"

export function decodeMcpRpcCommand(key: string, message: unknown): McpCommand | undefined {
	const request = asRecord(message), serverName = readString(request.serverName) || readString(request.name) || readString(request.value)
	switch (key) {
		case "McpService.getLatestMcpServers": return { type: "list" }
		case "McpService.refreshMcpMarketplace": return { type: "marketplace" }
		case "McpService.openMcpSettings": return { type: "openSettings" }
		case "McpService.addRemoteMcpServer": return { type: "mutate", mutation: { action: "addRemoteServer", request: { serverName: readString(request.serverName) || readString(request.name), serverUrl: readString(request.serverUrl) || readString(request.url), transportType: readString(request.transportType) === "sse" ? "sse" : "streamableHttp" } } }
		case "McpService.updateMcpTimeout": return { type: "mutate", mutation: { action: "updateTimeout", request: { serverName, timeout: optionalNumber(request.timeout) } } }
		case "McpService.restartMcpServer": return targetMutation("restartServer", serverName)
		case "McpService.deleteMcpServer": return targetMutation("deleteServer", serverName)
		case "McpService.toggleToolAutoApprove": return { type: "mutate", mutation: { action: "toggleToolAutoApprove", request: { serverName: readString(request.serverName) || readString(request.name), toolNames: stringArray(request.toolNames), autoApprove: request.autoApprove === true } } }
		case "McpService.toggleMcpServer": return { type: "mutate", mutation: { action: "toggleServer", request: { serverName, disabled: request.disabled === true } } }
		case "McpService.authenticateMcpServer": return targetMutation("authenticateServer", serverName)
		case "McpService.downloadMcp": return { type: "unsupportedDownload" }
		default: return undefined
	}
}

function targetMutation(action: "restartServer" | "deleteServer" | "authenticateServer", serverName: string): McpCommand { return { type: "mutate", mutation: { action, request: { serverName } } } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function optionalNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [] }
