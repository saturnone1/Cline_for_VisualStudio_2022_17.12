import type { StreamCommand } from "../../features/web/StreamingRpcHandler"

const inertStreams = new Set([
	"UiService.subscribeToMcpButtonClicked", "UiService.subscribeToHistoryButtonClicked", "UiService.subscribeToChatButtonClicked",
	"UiService.subscribeToSettingsButtonClicked", "UiService.subscribeToWorktreesButtonClicked", "UiService.subscribeToAccountButtonClicked",
	"UiService.subscribeToRelinquishControl", "UiService.subscribeToShowWebview", "UiService.subscribeToAddToInput",
	"McpService.subscribeToMcpMarketplaceCatalog", "ModelsService.subscribeToOpenRouterModels", "ModelsService.subscribeToLiteLlmModels",
])

export function decodeStreamingRpcCommand(key: string): StreamCommand | undefined {
	if (key === "StateService.subscribeToState") return { type: "state" }
	if (key === "AccountService.subscribeToAuthStatusUpdate" || key === "OcaAccountService.ocaSubscribeToAuthStatusUpdate") return { type: "auth" }
	if (key === "UiService.subscribeToPartialMessage") return { type: "partial" }
	if (key === "McpService.subscribeToMcpServers") return { type: "mcpServers" }
	if (key === "McpService.subscribeToMcpMarketplaceCatalog") return { type: "mcpMarketplace" }
	return inertStreams.has(key) ? { type: "inert" } : undefined
}
