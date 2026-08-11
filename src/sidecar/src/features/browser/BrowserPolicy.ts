import type { BrowserAction, BrowserViewport } from "../../application/ports/BrowserAutomationPort"
export type { BrowserAction, BrowserViewport } from "../../application/ports/BrowserAutomationPort"

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
		case "scroll_down": case "scroll_up": case "click": case "type": case "press_enter": case "close": return normalized
		default: return normalized || "navigate"
	}
}

export function browserActionResultForTranscript(result: Record<string, unknown>) {
	const screenshot = normalizeBrowserPreview(readString(result.screenshot))
	return { screenshot, screenshotBytes: screenshotByteLength(screenshot), currentUrl: normalizeBrowserUrl(readString(result.currentUrl) || readString(result.url)), pageText: truncate(readString(result.pageText), 20_000), elements: normalizeBrowserElements(result.elements), logs: truncate(readString(result.error) || (result.success === false ? "Browser action failed." : ""), 2_000), currentMousePosition: readString(result.currentMousePosition), browserSessionId: readString(result.browserSessionId), tabId: readString(result.tabId), url: normalizeBrowserUrl(readString(result.url)), title: truncate(readString(result.title), 500), action: readString(result.action), status: readString(result.status), error: truncate(readString(result.error), 2_000) }
}

export function browserActionResultTextForSnapshot(value: string) {
	try {
		const parsed = JSON.parse(value)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ""
		return JSON.stringify(browserActionResultForTranscript(parsed as Record<string, unknown>))
	} catch {
		return ""
	}
}

export function shouldCaptureBrowserPreview(action: string) {
	return normalizeBrowserActionName(action) !== "close"
}

export function normalizeBrowserUrl(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return ""
	const angleUrls = [...trimmed.matchAll(/<(https?:\/\/[^>]+)>/gi)]
	const candidate = (angleUrls.at(-1)?.[1] || trimmed).replace(/\\&/g, "&")
	if (candidate === "about:blank") return candidate
	try {
		const parsed = new URL(candidate)
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? candidate : ""
	} catch {
		return ""
	}
}

export function normalizeBrowserElements(value: unknown) {
	if (!Array.isArray(value)) return []
	return value
		.map(asRecord)
		.filter((element) => element.visible !== false)
		.slice(0, 80)
		.map((element) => ({
			index: numberValue(element.index),
			tag: truncate(readString(element.tag), 40),
			type: truncate(readString(element.type), 40),
			label: normalizeElementLabel(readString(element.label)),
			x: numberValue(element.x),
			y: numberValue(element.y),
			visible: element.visible === true,
		}))
}

export function screenshotByteLength(value: string) {
	const index = value.indexOf("base64,")
	if (index < 0) return 0
	const payload = value.slice(index + 7).replace(/\s/g, "")
	const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
	return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}
const BROWSER_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
function normalizeBrowserPreview(value: string) {
	if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(value)) return ""
	return screenshotByteLength(value) <= BROWSER_PREVIEW_MAX_BYTES ? value : ""
}
export function isBrowserToolName(toolName: string) { return ["browser", "browser_action", "browseraction", "browser_action_launch", "browser_action_result"].includes(toolName.trim().toLowerCase()) }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
function truncate(value: string, limit: number) { return value.length <= limit ? value : `${value.slice(0, limit)}...` }
function normalizeElementLabel(value: string) {
	const normalized = value.replace(/\s+/g, " ").trim()
	if (/^[.#][\w-]+\s*\{/.test(normalized) || normalized.includes("{display:") || normalized.includes(";color:")) return ""
	return truncate(normalized, 240)
}
