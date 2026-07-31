import { InactivityWatchdog } from "../../application/services/InactivityWatchdog"

export type BoundedFetchOptions = Readonly<{
	timeoutMs: number
	maximumBytes: number
	signal?: AbortSignal
	graceChecks?: number
	onWaiting?: (quietForMs: number, check: number) => void
}>

export async function fetchBoundedText(
	input: string | URL,
	init: RequestInit,
	options: BoundedFetchOptions,
): Promise<{ response: Response; text: string }> {
	const controller = new AbortController()
	const abortFromCaller = () => controller.abort(options.signal?.reason)
	if (options.signal?.aborted) abortFromCaller()
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true })
	const watchdog = new InactivityWatchdog({
		inactivityMs: options.timeoutMs,
		graceChecks: options.graceChecks,
		onWaiting: options.onWaiting,
		onTimeout: () => controller.abort(new Error("Request became unresponsive.")),
	}).start()

	try {
		const response = await fetch(input, { ...init, signal: controller.signal })
		watchdog.touch()
		const declaredLength = Number(response.headers?.get?.("content-length") || "")
		if (Number.isFinite(declaredLength) && declaredLength > options.maximumBytes) {
			throw new BoundedFetchError(`Response exceeded the ${options.maximumBytes}-byte limit.`)
		}
		return { response, text: await readBoundedResponseText(response, options.maximumBytes, () => watchdog.touch()) }
	} catch (error) {
		if (controller.signal.aborted && !(error instanceof BoundedFetchError)) {
			if (options.signal?.aborted) throw new BoundedFetchError("Request was cancelled.")
			throw new BoundedFetchError(`Request remained unresponsive after repeated ${options.timeoutMs}ms checks.`)
		}
		throw error
	} finally {
		watchdog.dispose()
		options.signal?.removeEventListener("abort", abortFromCaller)
	}
}

async function readBoundedResponseText(response: Response, maximumBytes: number, onActivity: () => void) {
	const reader = response.body?.getReader?.()
	if (!reader) {
		const text = await response.text()
		if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new BoundedFetchError(`Response exceeded the ${maximumBytes}-byte limit.`)
		return text
	}

	const decoder = new TextDecoder()
	let totalBytes = 0
	let text = ""
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		onActivity()
		totalBytes += value.byteLength
		if (totalBytes > maximumBytes) {
			await reader.cancel().catch(() => undefined)
			throw new BoundedFetchError(`Response exceeded the ${maximumBytes}-byte limit.`)
		}
		text += decoder.decode(value, { stream: true })
	}
	return text + decoder.decode()
}

export class BoundedFetchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "BoundedFetchError"
	}
}
