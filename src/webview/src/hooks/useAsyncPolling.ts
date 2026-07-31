import { useEffect, useRef } from "react"

interface AsyncPollingOptions {
	enabled: boolean
	intervalMs: number
	poll: () => Promise<unknown> | unknown
}

/** Runs at most one poll at a time and pauses host traffic while the WebView is hidden. */
export function useAsyncPolling({ enabled, intervalMs, poll }: AsyncPollingOptions) {
	const pollRef = useRef(poll)
	pollRef.current = poll

	useEffect(() => {
		if (!enabled) return
		let disposed = false
		let running = false
		let timer: number | undefined

		const schedule = () => {
			if (disposed) return
			if (timer !== undefined) window.clearTimeout(timer)
			timer = window.setTimeout(() => void run(), intervalMs)
		}
		const run = async () => {
			if (disposed || running) return
			if (document.visibilityState === "hidden") {
				schedule()
				return
			}
			running = true
			try {
				await pollRef.current()
			} finally {
				running = false
				schedule()
			}
		}
		const onVisibilityChange = () => {
			if (document.visibilityState !== "visible" || running) return
			if (timer !== undefined) {
				window.clearTimeout(timer)
				timer = undefined
			}
			void run()
		}

		document.addEventListener("visibilitychange", onVisibilityChange)
		void run()
		return () => {
			disposed = true
			if (timer !== undefined) window.clearTimeout(timer)
			document.removeEventListener("visibilitychange", onVisibilityChange)
		}
	}, [enabled, intervalMs])
}
