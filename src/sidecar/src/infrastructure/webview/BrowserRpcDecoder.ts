import type { BrowserCommand } from "../../features/browser/BrowserRpcHandler"

export function decodeBrowserRpcCommand(key: string, message: unknown): BrowserCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "BrowserService.getDetectedChromePath": return { type: "detectedPath" }
		case "BrowserService.getBrowserConnectionInfo": return { type: "connectionInfo" }
		case "BrowserService.testBrowserConnection": return { type: "testConnection", host: readString(request.value) || readString(request.host) || readString(request.url) }
		case "BrowserService.discoverBrowser": return { type: "discover" }
		case "BrowserService.relaunchChromeDebugMode": return { type: "relaunchInstructions" }
		case "BrowserService.listBrowserTabs": return { type: "listTabs" }
		case "BrowserService.captureScreenshot": return { type: "captureScreenshot", request: { tabId: readString(request.tabId) } }
		case "BrowserService.performBrowserAction":
		case "BrowserService.executeBrowserAction": return { type: "performAction", request: normalizeAction(request) }
		default: return undefined
	}
}

function normalizeAction(request: Record<string, unknown>) {
	return {
		action: readString(request.action) || readString(request.name) || "navigate",
		url: readString(request.url) || readString(request.value),
		tabId: readString(request.tabId),
		browserSessionId: readString(request.browserSessionId),
		coordinate: readString(request.coordinate),
		text: readString(request.text),
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
