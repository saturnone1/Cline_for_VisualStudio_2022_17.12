import { wrapAgentToolFailureContext } from "./AgentToolFailureBoundary"

export function wrapMcpToolFailureContext(
	tool: Record<string, unknown>,
	serverName: string,
	toolName: string,
	onFailure: (message: string) => void = () => undefined,
	onSuccess: () => void = () => undefined,
) {
	return wrapAgentToolFailureContext(tool, `MCP ${serverName}.${toolName}`, (message) => onFailure(message), onSuccess)
}
