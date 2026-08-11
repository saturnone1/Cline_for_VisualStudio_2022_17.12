import type { AddRemoteMcpServerRequest, McpRuntimePort, McpServerTargetRequest, ToggleMcpServerRequest, ToggleMcpToolRequest, UpdateMcpTimeoutRequest } from "../../application/ports/McpRuntimePort"

export type McpMutationRequest =
	| Readonly<{ action: "addRemoteServer"; request: AddRemoteMcpServerRequest }>
	| Readonly<{ action: "updateTimeout"; request: UpdateMcpTimeoutRequest }>
	| Readonly<{ action: "restartServer" | "deleteServer" | "authenticateServer"; request: McpServerTargetRequest }>
	| Readonly<{ action: "toggleToolAutoApprove"; request: ToggleMcpToolRequest }>
	| Readonly<{ action: "toggleServer"; request: ToggleMcpServerRequest }>

export class McpHandler {
	constructor(private readonly runtime: McpRuntimePort) {}

	listServers() { return this.runtime.getMcpServersResponse() }
	getSettingsPath() { return this.runtime.getMcpSettingsPath() }

	mutate(command: McpMutationRequest) {
		switch (command.action) {
			case "addRemoteServer": return this.runtime.addRemoteMcpServer(command.request)
			case "updateTimeout": return this.runtime.updateMcpTimeout(command.request)
			case "restartServer": return this.runtime.restartMcpServer(command.request)
			case "deleteServer": return this.runtime.deleteMcpServer(command.request)
			case "toggleToolAutoApprove": return this.runtime.toggleMcpToolAutoApprove(command.request)
			case "toggleServer": return this.runtime.setMcpServerDisabled(command.request)
			case "authenticateServer": return this.runtime.authenticateMcpServer(command.request)
		}
	}
}
