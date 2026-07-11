export type BrowserViewport = { width: number; height: number }
export type BrowserAction = { action: string; url?: string; tabId?: string; browserSessionId?: string; browserActionId?: string; coordinate?: string; text?: string; viewport: BrowserViewport; onPhase?: (phase: Record<string, unknown>) => void }

export function normalizeBrowserDebugHost(host: string) {
	const trimmed = host.trim()
	if (!trimmed) return ""
	return (/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).replace(/\/+$/, "")
}

export function normalizeBrowserViewport(value: unknown): BrowserViewport {
	const record = asRecord(value)
	return { width: Math.max(320, Math.min(numberValue(record.width) || 900, 4096)), height: Math.max(240, Math.min(numberValue(record.height) || 600, 4096)) }
}

export function normalizeBrowserActionName(value: string) {
	const normalized = value.trim().toLowerCase().replace(/[-\s]/g, "_")
	switch (normalized) {
		case "browser_action_launch": case "launch_browser": case "launch": return "launch"
		case "open": case "goto": case "go_to": case "navigate": return "navigate"
		case "screenshot": case "capture_screenshot": return "screenshot"
		case "scroll_down": case "scroll_up": case "click": case "type": case "close": return normalized
		default: return normalized || "navigate"
	}
}

export function browserActionResultForTranscript(result: Record<string, unknown>) {
	return { screenshot: readString(result.screenshot), screenshotBytes: numberValue(result.screenshotBytes) || screenshotByteLength(readString(result.screenshot)), currentUrl: readString(result.currentUrl) || readString(result.url), logs: readString(result.error) || (result.success === false ? "Browser action failed." : ""), currentMousePosition: readString(result.currentMousePosition), browserSessionId: readString(result.browserSessionId), tabId: readString(result.tabId), url: readString(result.url), title: readString(result.title), action: readString(result.action), status: readString(result.status), error: readString(result.error) }
}

export function screenshotByteLength(value: string) { const index = value.indexOf("base64,"); return index < 0 ? 0 : Math.floor((value.slice(index + 7).length * 3) / 4) }
export function isBrowserToolName(toolName: string) { return ["browser", "browser_action", "browseraction", "browser_action_launch", "browser_action_result"].includes(toolName.trim().toLowerCase()) }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
