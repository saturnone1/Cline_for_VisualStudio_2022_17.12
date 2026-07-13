import { act, renderHook } from "@testing-library/react"
import { vi } from "vitest"
import { useChatInputSubmit } from "./useChatInputSubmit"

describe("useChatInputSubmit", () => {
	it("sends once and clears focus when input is enabled", () => {
		const onSend = vi.fn()
		const setIsTextAreaFocused = vi.fn()
		const { result } = renderHook(() =>
			useChatInputSubmit({ sendingDisabled: false, requestPending: false, onSend, setIsTextAreaFocused }),
		)

		let outcome: ReturnType<typeof result.current.submitOrCancel> | undefined
		act(() => {
			outcome = result.current.submitOrCancel()
		})

		expect(outcome).toBe("sent")
		expect(onSend).toHaveBeenCalledTimes(1)
		expect(setIsTextAreaFocused).toHaveBeenCalledWith(false)
	})

	it("cancels a pending request without sending a second message", () => {
		const onSend = vi.fn()
		const onCancelRequest = vi.fn()
		const { result } = renderHook(() =>
			useChatInputSubmit({
				sendingDisabled: true,
				requestPending: true,
				onSend,
				onCancelRequest,
				setIsTextAreaFocused: vi.fn(),
			}),
		)

		act(() => result.current.submitOrCancel())

		expect(onCancelRequest).toHaveBeenCalledTimes(1)
		expect(onSend).not.toHaveBeenCalled()
	})
})
