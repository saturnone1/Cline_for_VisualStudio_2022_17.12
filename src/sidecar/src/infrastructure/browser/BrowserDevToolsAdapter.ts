import fs from "node:fs"
import path from "node:path"

export function resolveBrowserExecutablePath(configuredPath = "") {
	const candidates = [
		configuredPath,
		process.env.CHROME_PATH || "",
		process.env.EDGE_PATH || "",
		process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
		process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"] as string, "Google", "Chrome", "Application", "chrome.exe") : "",
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
		process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe") : "",
		process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"] as string, "Microsoft", "Edge", "Application", "msedge.exe") : "",
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : "",
	]

	return candidates.find((candidate) => candidate.trim() && fs.existsSync(candidate)) || ""
}

export function normalizeBrowserDebugHost(host: string) {
	const trimmed = host.trim()
	if (!trimmed) {
		return ""
	}

	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
	return withProtocol.replace(/\/+$/, "")
}

export async function canReachBrowserDebugHost(host: string) {
	return (await fetchBrowserDebugInfo(host)).success === true
}

export async function fetchBrowserDebugInfo(host: string) {
	const normalized = normalizeBrowserDebugHost(host)
	if (!normalized) {
		return { success: false, error: "Browser debug host is not configured." }
	}

	const timeoutMs = readPositiveIntEnv("VSCLINE_BROWSER_CONNECT_TIMEOUT_MS", 2000)
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const versionResponse = await fetch(`${normalized}/json/version`, { signal: controller.signal })
		if (!versionResponse.ok) {
			return { success: false, host: normalized, error: `Browser debug host returned HTTP ${versionResponse.status}.` }
		}

		const version = asRecord(await versionResponse.json().catch(() => ({})))
		const tabsResponse = await fetch(`${normalized}/json/list`, { signal: controller.signal }).catch(() => null)
		const tabs = tabsResponse?.ok ? await tabsResponse.json().catch(() => []) : []
		const tabRecords = Array.isArray(tabs) ? tabs.map(asRecord) : []
		const pageTabs = tabRecords.filter((tab) => getString(tab, "type") === "page")
		const activeTab = pageTabs[0] || tabRecords[0] || {}
		return {
			success: true,
			host: normalized,
			browser: getString(version, "Browser"),
			protocolVersion: getString(version, "Protocol-Version"),
			tabCount: pageTabs.length || tabRecords.length,
			activeTabTitle: getString(activeTab, "title"),
			activeTabUrl: getString(activeTab, "url"),
		}
	} catch (error) {
		const message = error instanceof Error && error.name === "AbortError"
			? `Browser debug connection timed out after ${Math.round(timeoutMs / 1000)} seconds.`
			: stringify(error)
		return { success: false, host: normalized, error: message }
	} finally {
		clearTimeout(timer)
	}
}

type BrowserViewport = { width: number; height: number }
type DevToolsTab = {
	id: string
	type: string
	url: string
	title: string
	webSocketDebuggerUrl: string
}
export type BrowserAdapterAction = {
	action: string
	url?: string
	tabId?: string
	browserSessionId?: string
	browserActionId?: string
	coordinate?: string
	text?: string
	viewport: BrowserViewport
	onPhase?: (phase: Record<string, unknown>) => void
}

export function normalizeBrowserViewport(value: unknown): BrowserViewport {
	const record = asRecord(value)
	return {
		width: Math.max(320, Math.min(numberValue(record.width) || 900, 4096)),
		height: Math.max(240, Math.min(numberValue(record.height) || 600, 4096)),
	}
}

export function normalizeBrowserActionName(value: string) {
	const normalized = value.trim().toLowerCase().replace(/[-\s]/g, "_")
	switch (normalized) {
		case "browser_action_launch":
		case "launch_browser":
		case "launch":
			return "launch"
		case "open":
		case "goto":
		case "go_to":
		case "navigate":
			return "navigate"
		case "screenshot":
		case "capture_screenshot":
			return "screenshot"
		case "scroll_down":
		case "scroll_up":
		case "click":
		case "type":
		case "close":
			return normalized
		default:
			return normalized || "navigate"
	}
}

export async function listDevToolsTabs(host: string) {
	const normalized = normalizeBrowserDebugHost(host)
	if (!normalized) {
		return { success: false, tabs: [], error: "Browser debug host is not configured." }
	}
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), readPositiveIntEnv("VSCLINE_BROWSER_CONNECT_TIMEOUT_MS", 2000))
	try {
		const response = await fetch(`${normalized}/json/list`, { signal: controller.signal })
		if (!response.ok) {
			return { success: false, host: normalized, tabs: [], error: `Browser tab list returned HTTP ${response.status}.` }
		}
		const tabs = arrayOfRecords(await response.json().catch(() => []))
			.filter((tab) => getString(tab, "type") === "page")
			.map((tab) => ({
				id: getString(tab, "id"),
				type: getString(tab, "type"),
				url: getString(tab, "url"),
				title: getString(tab, "title"),
				webSocketDebuggerUrl: getString(tab, "webSocketDebuggerUrl"),
			}))
			.filter((tab) => tab.id && tab.webSocketDebuggerUrl)
		return { success: true, host: normalized, tabs }
	} catch (error) {
		const message = error instanceof Error && error.name === "AbortError"
			? "Browser tab list timed out."
			: stringify(error)
		return { success: false, host: normalized, tabs: [], error: message }
	} finally {
		clearTimeout(timer)
	}
}

export async function runBrowserActionViaDevTools(host: string, request: BrowserAdapterAction) {
	const normalized = normalizeBrowserDebugHost(host)
	if (!normalized) {
		return { success: false, status: "error", error: "Browser debug host is not configured." }
	}
	if (typeof (globalThis as Record<string, unknown>).WebSocket !== "function") {
		return { success: false, status: "unsupported", error: "Node WebSocket runtime is unavailable; bundled Node 22+ is required." }
	}

	try {
		request.onPhase?.({ phase: "resolving_tab", action: normalizeBrowserActionName(request.action), host: normalized })
		let tab = await resolveDevToolsTab(normalized, request)
		let lastError: unknown
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				request.onPhase?.({ phase: attempt > 0 ? "reconnected" : "connected", action: normalizeBrowserActionName(request.action), tabId: tab.id })
				return await executeBrowserActionOnDevToolsTab(normalized, tab, request)
			} catch (error) {
				lastError = error
				if (attempt > 0 || !isRetryableDevToolsError(error)) {
					throw error
				}
				request.onPhase?.({
					phase: "reconnecting",
					action: normalizeBrowserActionName(request.action),
					tabId: tab.id,
					reconnectReason: stringify(error),
				})
				tab = await resolveDevToolsTab(normalized, { ...request, tabId: "" })
			}
		}
		throw lastError
	} catch (error) {
		return {
			success: false,
			status: "error",
			action: normalizeBrowserActionName(request.action),
			browserSessionId: request.browserSessionId || normalized,
			browserActionId: request.browserActionId,
			error: stringify(error),
		}
	}
}

async function executeBrowserActionOnDevToolsTab(host: string, tab: DevToolsTab, request: BrowserAdapterAction) {
	const client = await connectDevTools(tab.webSocketDebuggerUrl)
	try {
		request.onPhase?.({ phase: "preparing", action: normalizeBrowserActionName(request.action), tabId: tab.id })
		await client.send("Page.enable")
		await client.send("Runtime.enable")
		await client.send("Emulation.setDeviceMetricsOverride", {
			width: request.viewport.width,
			height: request.viewport.height,
			deviceScaleFactor: 1,
			mobile: false,
		})

		const action = normalizeBrowserActionName(request.action)
		if ((action === "launch" || action === "navigate") && request.url) {
			request.onPhase?.({ phase: "navigating", action, tabId: tab.id, url: request.url })
			const loaded = client.waitForEvent("Page.loadEventFired", readPositiveIntEnv("VSCLINE_BROWSER_NAVIGATION_TIMEOUT_MS", 10000))
			await client.send("Page.navigate", { url: normalizeBrowserNavigationUrl(request.url) })
			await loaded.catch(() => waitForDevToolsSettle())
		} else if (action === "click") {
			request.onPhase?.({ phase: "clicking", action, tabId: tab.id, coordinate: request.coordinate })
			const coordinate = parseBrowserCoordinate(request.coordinate, request.viewport)
			await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: coordinate.x, y: coordinate.y, button: "left", clickCount: 1 })
			await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: coordinate.x, y: coordinate.y, button: "left", clickCount: 1 })
			await waitForDevToolsSettle(250)
		} else if (action === "type") {
			request.onPhase?.({ phase: "typing", action, tabId: tab.id })
			await client.send("Input.insertText", { text: request.text || "" })
			await waitForDevToolsSettle(150)
		} else if (action === "scroll_down" || action === "scroll_up") {
			request.onPhase?.({ phase: "scrolling", action, tabId: tab.id })
			await client.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: Math.round(request.viewport.width / 2),
				y: Math.round(request.viewport.height / 2),
				deltaY: action === "scroll_down" ? request.viewport.height * 0.75 : -request.viewport.height * 0.75,
				deltaX: 0,
			})
			await waitForDevToolsSettle(250)
		} else if (action === "close") {
			request.onPhase?.({ phase: "closing", action, tabId: tab.id })
			await closeDevToolsTab(host, tab.id)
			return {
				success: true,
				status: "closed",
				action,
				browserSessionId: request.browserSessionId || host,
				browserActionId: request.browserActionId,
				tabId: tab.id,
				url: tab.url,
				title: tab.title,
				currentUrl: tab.url,
			}
		}

		request.onPhase?.({ phase: "capturing", action, tabId: tab.id })
		const state = await readDevToolsPageState(client)
		const screenshot = await captureDevToolsScreenshot(client)
		return {
			success: true,
			status: "ok",
			action,
			browserSessionId: request.browserSessionId || host,
			browserActionId: request.browserActionId,
			tabId: tab.id,
			url: state.url || tab.url,
			title: state.title || tab.title,
			currentUrl: state.url || tab.url,
			screenshot,
		}
	} finally {
		client.close()
	}
}

async function resolveDevToolsTab(host: string, request: BrowserAdapterAction): Promise<DevToolsTab> {
	const action = normalizeBrowserActionName(request.action)
	if ((action === "launch" || action === "navigate") && request.url && !request.tabId) {
		const created = await createDevToolsTab(host, request.url).catch(() => undefined)
		if (created?.webSocketDebuggerUrl) {
			return created
		}
	}

	const list = await listDevToolsTabs(host)
	const tabs = Array.isArray(list.tabs) ? list.tabs as DevToolsTab[] : []
	const tab = tabs.find((candidate) => candidate.id === request.tabId) || tabs[0]
	if (!tab) {
		throw new Error("No Chrome DevTools page tab is available. Open Chrome or Edge with --remote-debugging-port=9222.")
	}
	return tab
}

async function createDevToolsTab(host: string, url: string): Promise<DevToolsTab | undefined> {
	const target = `${host}/json/new?${encodeURIComponent(normalizeBrowserNavigationUrl(url))}`
	const response = await fetch(target, { method: "PUT" }).catch(() => fetch(target))
	if (!response.ok) {
		return undefined
	}
	const tab = asRecord(await response.json().catch(() => ({})))
	const webSocketDebuggerUrl = getString(tab, "webSocketDebuggerUrl")
	if (!webSocketDebuggerUrl) {
		return undefined
	}
	return {
		id: getString(tab, "id"),
		type: getString(tab, "type"),
		url: getString(tab, "url"),
		title: getString(tab, "title"),
		webSocketDebuggerUrl,
	}
}

async function closeDevToolsTab(host: string, tabId: string) {
	if (!tabId) {
		return
	}
	await fetch(`${host}/json/close/${encodeURIComponent(tabId)}`).catch(() => undefined)
}

function connectDevTools(webSocketDebuggerUrl: string) {
	const WebSocketCtor = (globalThis as Record<string, any>).WebSocket
	const socket = new WebSocketCtor(webSocketDebuggerUrl)
	let nextId = 1
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	const eventWaiters = new Map<string, Array<{ resolve: (value: unknown) => void; timer: NodeJS.Timeout }>>()
	const opened = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out opening Chrome DevTools WebSocket.")), readPositiveIntEnv("VSCLINE_BROWSER_CONNECT_TIMEOUT_MS", 2000))
		socket.addEventListener("open", () => {
			clearTimeout(timeout)
			resolve()
		})
		socket.addEventListener("error", () => {
			clearTimeout(timeout)
			reject(new Error("Chrome DevTools WebSocket connection failed."))
		})
	})

	socket.addEventListener("message", (event: { data: unknown }) => {
		const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8")
		const message = asRecord(tryParseJson(data) || {})
		const id = numberValue(message.id)
		const method = getString(message, "method")
		if (method && eventWaiters.has(method)) {
			const waiters = eventWaiters.get(method) || []
			eventWaiters.delete(method)
			for (const waiter of waiters) {
				clearTimeout(waiter.timer)
				waiter.resolve(message.params ?? message)
			}
		}
		if (!id || !pending.has(id)) {
			return
		}
		const waiter = pending.get(id)!
		pending.delete(id)
		const error = asRecord(message.error)
		if (Object.keys(error).length > 0) {
			waiter.reject(new Error(getString(error, "message") || JSON.stringify(error)))
		} else {
			waiter.resolve(message.result)
		}
	})

	socket.addEventListener("close", () => {
		for (const waiter of pending.values()) {
			waiter.reject(new Error("Chrome DevTools WebSocket closed."))
		}
		pending.clear()
		for (const waiters of eventWaiters.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer)
				waiter.resolve(undefined)
			}
		}
		eventWaiters.clear()
	})

	return {
		async send(method: string, params?: Record<string, unknown>) {
			await opened
			const id = nextId++
			const timeoutMs = readPositiveIntEnv("VSCLINE_BROWSER_ACTION_TIMEOUT_MS", 8000)
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id)
					reject(new Error(`Chrome DevTools command timed out: ${method}`))
				}, timeoutMs)
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timer)
						resolve(value)
					},
					reject: (error) => {
						clearTimeout(timer)
						reject(error)
					},
				})
				socket.send(JSON.stringify({ id, method, params: params || {} }))
			})
		},
		async waitForEvent(method: string, timeoutMs: number) {
			await opened
			return new Promise<unknown>((resolve) => {
				const timer = setTimeout(() => {
					const waiters = eventWaiters.get(method) || []
					eventWaiters.set(method, waiters.filter((waiter) => waiter.resolve !== resolve))
					resolve(undefined)
				}, Math.max(1, timeoutMs))
				const waiters = eventWaiters.get(method) || []
				waiters.push({ resolve, timer })
				eventWaiters.set(method, waiters)
			})
		},
		close() {
			try {
				socket.close()
			} catch {
				// ignore close errors
			}
		},
	}
}

async function readDevToolsPageState(client: Awaited<ReturnType<typeof connectDevTools>>) {
	const result = asRecord(await client.send("Runtime.evaluate", {
		expression: "({ url: location.href, title: document.title })",
		returnByValue: true,
	}))
	return asRecord(asRecord(asRecord(result.result).value))
}

async function captureDevToolsScreenshot(client: Awaited<ReturnType<typeof connectDevTools>>) {
	const result = asRecord(await client.send("Page.captureScreenshot", { format: "png", fromSurface: true }))
	const data = getString(result, "data")
	return data ? `data:image/png;base64,${data}` : ""
}

function parseBrowserCoordinate(coordinate: string | undefined, viewport: BrowserViewport) {
	const match = /^(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)$/.exec(coordinate || "")
	return {
		x: match ? Math.max(0, Math.min(Number(match[1]), viewport.width)) : Math.round(viewport.width / 2),
		y: match ? Math.max(0, Math.min(Number(match[2]), viewport.height)) : Math.round(viewport.height / 2),
	}
}

function normalizeBrowserNavigationUrl(value: string) {
	const trimmed = value.trim()
	if (!trimmed) {
		return "about:blank"
	}
	if (/^(https?|file|about):/i.test(trimmed)) {
		return trimmed
	}
	return `https://${trimmed}`
}

export function browserActionResultForTranscript(result: Record<string, unknown>) {
	return {
		screenshot: getString(result, "screenshot"),
		screenshotBytes: numberValue(result.screenshotBytes) || screenshotByteLength(getString(result, "screenshot")),
		currentUrl: getString(result, "currentUrl") || getString(result, "url"),
		logs: getString(result, "error") || (result.success === false ? "Browser action failed." : ""),
		currentMousePosition: getString(result, "currentMousePosition"),
		browserSessionId: getString(result, "browserSessionId"),
		tabId: getString(result, "tabId"),
		url: getString(result, "url"),
		title: getString(result, "title"),
		action: getString(result, "action"),
		status: getString(result, "status"),
		error: getString(result, "error"),
	}
}

export function screenshotByteLength(value: string) {
	const marker = "base64,"
	const index = value.indexOf(marker)
	if (index < 0) {
		return 0
	}
	const base64 = value.slice(index + marker.length)
	return Math.floor((base64.length * 3) / 4)
}

export function isBrowserToolName(toolName: string) {
	const normalized = toolName.trim().toLowerCase()
	return normalized === "browser" ||
		normalized === "browser_action" ||
		normalized === "browseraction" ||
		normalized === "browser_action_launch" ||
		normalized === "browser_action_result"
}

function isRetryableDevToolsError(error: unknown) {
	const text = stringify(error).toLowerCase()
	return text.includes("websocket closed") ||
		text.includes("target closed") ||
		text.includes("no chrome devtools page tab") ||
		text.includes("cannot find context") ||
		text.includes("inspected target")
}

function waitForDevToolsSettle(ms = 500) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function checkIsImageUrl(url: string) {
	const normalized = normalizeHttpUrl(url)
	if (!normalized) {
		return { value: false, success: false }
	}
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), readPositiveIntEnv("VSCLINE_WEB_FETCH_TIMEOUT_MS", 5000))
	try {
		const response = await fetch(normalized, { method: "HEAD", signal: controller.signal })
		const contentType = response.headers.get("content-type") || ""
		return { value: response.ok && contentType.toLowerCase().startsWith("image/"), contentType, success: response.ok }
	} catch (error) {
		return { value: false, success: false, error: stringify(error) }
	} finally {
		clearTimeout(timeout)
	}
}

export async function fetchOpenGraphData(url: string) {
	const normalized = normalizeHttpUrl(url)
	if (!normalized) {
		return { success: false, error: "Invalid URL." }
	}
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), readPositiveIntEnv("VSCLINE_WEB_FETCH_TIMEOUT_MS", 8000))
	try {
		const response = await fetch(normalized, {
			signal: controller.signal,
			headers: { Accept: "text/html,*/*;q=0.5", "User-Agent": "LIG-VS/1.0 VisualStudio2022" },
		})
		if (!response.ok) {
			return { success: false, url: normalized, error: `HTTP ${response.status}` }
		}
		const html = await response.text()
		const title = extractHtmlMeta(html, "og:title") || extractHtmlTitle(html)
		const description = extractHtmlMeta(html, "og:description") || extractHtmlMeta(html, "description")
		const image = extractHtmlMeta(html, "og:image")
		return {
			success: true,
			url: normalized,
			title,
			description,
			image,
			siteName: extractHtmlMeta(html, "og:site_name"),
		}
	} catch (error) {
		return { success: false, url: normalized, error: stringify(error) }
	} finally {
		clearTimeout(timeout)
	}
}

function extractHtmlTitle(html: string) {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
	return match ? decodeBasicHtmlEntities(match[1].replace(/\s+/g, " ").trim()) : ""
}

function extractHtmlMeta(html: string, key: string) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const propertyPattern = new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${escaped}["'])(?=[^>]*content=["']([^"']*)["'])[^>]*>`, "i")
	const match = propertyPattern.exec(html)
	return match ? decodeBasicHtmlEntities(match[1].trim()) : ""
}

function decodeBasicHtmlEntities(value: string) {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function getString(record: Record<string, unknown>, key: string) {
	const value = record[key]
	return typeof value === "string" ? value : value == null ? "" : String(value)
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : []
}

function numberValue(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringify(value: unknown) {
	if (typeof value === "string") return value
	try { return JSON.stringify(value) } catch { return String(value) }
}

function tryParseJson(value: string) {
	try { return JSON.parse(value) as unknown } catch { return undefined }
}

function readPositiveIntEnv(name: string, fallback: number) {
	const value = Number(process.env[name])
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function normalizeHttpUrl(value: string) {
	const raw = String(value || "").trim()
	if (!raw) return ""
	try { return new URL(raw).toString() } catch {
		try { return new URL(`https://${raw}`).toString() } catch { return "" }
	}
}
