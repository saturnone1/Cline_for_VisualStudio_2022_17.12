import { useCallback } from "react"

interface UseChatInputSubmitOptions {
	sendingDisabled: boolean
	requestPending: boolean
	onSend: () => void
	onCancelRequest?: () => void
	setIsTextAreaFocused: (value: boolean) => void
}

export function useChatInputSubmit({
	sendingDisabled,
	requestPending,
	onSend,
	onCancelRequest,
	setIsTextAreaFocused,
}: UseChatInputSubmitOptions) {
	const send = useCallback(() => {
		if (sendingDisabled) return false
		setIsTextAreaFocused(false)
		onSend()
		return true
	}, [onSend, sendingDisabled, setIsTextAreaFocused])

	const submitOrCancel = useCallback(() => {
		if (requestPending) {
			onCancelRequest?.()
			return "cancelled" as const
		}
		return send() ? ("sent" as const) : ("blocked" as const)
	}, [onCancelRequest, requestPending, send])

	return { send, submitOrCancel }
}
