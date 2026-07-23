import type { McpHandler, McpMutationRequest } from "./McpHandler"
import { throwIfOperationCancelled } from "../../application/services/OperationCancellation"

export type McpCommand =
	| Readonly<{ type: "list" }>
	| Readonly<{ type: "marketplace" }>
	| Readonly<{ type: "openSettings" }>
	| Readonly<{ type: "mutate"; mutation: McpMutationRequest }>
	| Readonly<{ type: "unsupportedDownload" }>

export type McpRpcResult = Readonly<{ payload?: unknown; error?: string; publishToStreams?: boolean }>

type Callbacks = Readonly<{
	mcp: () => McpHandler
	openSettings: (filePath: string) => Promise<unknown>
	markRuntimeChanged: () => void
}>

export class McpRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: McpCommand, signal?: AbortSignal): Promise<McpRpcResult> {
		throwIfOperationCancelled(signal)
		switch (command.type) {
			case "list": return { payload: await this.callbacks.mcp().listServers() }
			case "marketplace": return { payload: { catalog: { items: [] }, items: [] } }
			case "openSettings": await this.callbacks.openSettings(await this.callbacks.mcp().getSettingsPath()); return { payload: {} }
			case "mutate": {
				const payload = await this.callbacks.mcp().mutate(command.mutation)
				this.callbacks.markRuntimeChanged()
				return { payload, publishToStreams: true }
			}
			case "unsupportedDownload": return { error: "MCP marketplace installation is not implemented in the Visual Studio port yet. Add stdio/SSE/streamable HTTP servers from the MCP configuration file or Add Server tab." }
		}
	}
}
