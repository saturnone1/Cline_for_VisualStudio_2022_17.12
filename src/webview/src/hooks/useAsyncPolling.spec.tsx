import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useAsyncPolling } from "./useAsyncPolling"

describe("useAsyncPolling", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("does not overlap a slow poll", async () => {
		vi.useFakeTimers()
		let release: (() => void) | undefined
		const poll = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
		renderHook(() => useAsyncPolling({ enabled: true, intervalMs: 100, poll }))
		expect(poll).toHaveBeenCalledTimes(1)

		await act(async () => vi.advanceTimersByTimeAsync(500))
		expect(poll).toHaveBeenCalledTimes(1)
		await act(async () => release?.())
		await act(async () => vi.advanceTimersByTimeAsync(100))
		expect(poll).toHaveBeenCalledTimes(2)
	})

	it("stops scheduling after unmount", async () => {
		vi.useFakeTimers()
		const poll = vi.fn(async () => undefined)
		const view = renderHook(() => useAsyncPolling({ enabled: true, intervalMs: 100, poll }))
		await act(async () => undefined)
		view.unmount()
		await act(async () => vi.runAllTimersAsync())
		expect(poll).toHaveBeenCalledTimes(1)
	})
})
