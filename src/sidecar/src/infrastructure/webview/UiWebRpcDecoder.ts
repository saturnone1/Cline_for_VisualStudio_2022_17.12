import type { UiWebCommand } from "../../features/web/UiWebRpcHandler"
import { getExternalUrlValue } from "../conversation/ConversationMessageProjection"

export function decodeUiWebRpcCommand(key: string, message: unknown): UiWebCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "UiService.initializeWebview":
		case "UiService.openWalkthrough":
		case "UiService.setTerminalExecutionMode": return { type: "empty" }
		case "UiService.onDidShowAnnouncement": return { type: "announcement" }
		case "UiService.openUrl":
		case "WebService.openInBrowser": return { type: "openUrl", url: getExternalUrlValue(message) }
		case "WebService.checkIsImageUrl": return { type: "checkImage", url: readString(request.value) || readString(request.url) }
		case "WebService.fetchOpenGraphData": return { type: "openGraph", url: readString(request.value) || readString(request.url) }
		default: return undefined
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
