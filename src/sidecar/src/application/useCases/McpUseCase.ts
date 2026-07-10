import type { McpMutation, McpRuntimePort } from "../ports/McpRuntimePort"

export class McpUseCase {
	constructor(private readonly runtime: McpRuntimePort) {}

	listServers() {
		return this.runtime.getMcpServersResponse()
	}

	getSettingsPath() {
		return this.runtime.getMcpSettingsPath()
	}

	mutate(action: McpMutation, request: Record<string, unknown>) {
		switch (action) {
			case "addRemoteServer":
				return this.runtime.addRemoteMcpServer(request)
			case "updateTimeout":
				return this.runtime.updateMcpTimeout(request)
			case "restartServer":
				return this.runtime.restartMcpServer(request)
			case "deleteServer":
				return this.runtime.deleteMcpServer(request)
			case "toggleToolAutoApprove":
				return this.runtime.toggleMcpToolAutoApprove(request)
			case "toggleServer":
				return this.runtime.setMcpServerDisabled(request)
			case "authenticateServer":
				return this.runtime.authenticateMcpServer(request)
		}
	}
}
