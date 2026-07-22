import { EmptyRequest } from "@shared/proto/cline/common"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { useCallback, useEffect, useRef } from "react"
import { StateServiceClient, UiServiceClient } from "../services/grpcClient"
import { superviseStreamSubscription } from "../services/streamSubscriptionSupervisor"

export interface ExtensionSubscriptionCallbacks {
	onStateJson: (stateJson: string) => void
	onPartialMessage: (event: { taskId: string; message: ProtoClineMessage }) => void
	onTerminalProfiles: (profiles: Awaited<ReturnType<typeof StateServiceClient.getAvailableTerminalProfiles>>["profiles"]) => void
	navigateToMcp: () => void
	navigateToHistory: () => void
	navigateToChat: () => void
	navigateToSettings: () => void
	navigateToWorktrees: () => void
	navigateToAccount: () => void
}

export interface ExtensionSubscriptions {
	onRelinquishControl: (callback: () => void) => () => void
}

export function useExtensionSubscriptions(callbacks: ExtensionSubscriptionCallbacks): ExtensionSubscriptions {
	const callbacksRef = useRef(callbacks)
	callbacksRef.current = callbacks
	const relinquishControlCallbacks = useRef<Set<() => void>>(new Set())

	const onRelinquishControl = useCallback((callback: () => void) => {
		relinquishControlCallbacks.current.add(callback)
		return () => relinquishControlCallbacks.current.delete(callback)
	}, [])

	useEffect(() => {
		const unsubscribers: Array<() => void> = []
		const subscribe = <T,>(label: string, factory: (callbacks: { onResponse: (response: T) => void; onError: (error: Error) => void; onComplete: () => void }) => () => void, onResponse: (response: T) => void) => {
			unsubscribers.push(superviseStreamSubscription({
				label,
				subscribe: factory,
				onResponse,
				reportError: (stream, error) => console.error(`Error in ${stream} subscription:`, error),
			}))
		}

		subscribe<{ stateJson: string }>("state", (observer) => StateServiceClient.subscribeToState(EmptyRequest.create({}), observer), (response) => {
			if (response.stateJson) callbacksRef.current.onStateJson(response.stateJson)
		})
		subscribe("MCP navigation", (observer) => UiServiceClient.subscribeToMcpButtonClicked({}, observer), () => callbacksRef.current.navigateToMcp())
		subscribe("history navigation", (observer) => UiServiceClient.subscribeToHistoryButtonClicked({}, observer), () => callbacksRef.current.navigateToHistory())
		subscribe("chat navigation", (observer) => UiServiceClient.subscribeToChatButtonClicked({}, observer), () => callbacksRef.current.navigateToChat())
		subscribe("settings navigation", (observer) => UiServiceClient.subscribeToSettingsButtonClicked(EmptyRequest.create({}), observer), () => callbacksRef.current.navigateToSettings())
		subscribe("worktrees navigation", (observer) => UiServiceClient.subscribeToWorktreesButtonClicked(EmptyRequest.create({}), observer), () => callbacksRef.current.navigateToWorktrees())
		subscribe<{ taskId: string; message: ProtoClineMessage }>("partial message", (observer) => UiServiceClient.subscribeToPartialMessage(EmptyRequest.create({}), observer), (event) => callbacksRef.current.onPartialMessage(event))
		subscribe("account navigation", (observer) => UiServiceClient.subscribeToAccountButtonClicked(EmptyRequest.create({}), observer), () => callbacksRef.current.navigateToAccount())
		subscribe("relinquish control", (observer) => UiServiceClient.subscribeToRelinquishControl(EmptyRequest.create({}), observer), () => relinquishControlCallbacks.current.forEach((callback) => callback()))

		UiServiceClient.initializeWebview(EmptyRequest.create({})).catch((error) => {
			console.error("Failed to initialize webview via gRPC:", error)
		})
		StateServiceClient.getAvailableTerminalProfiles(EmptyRequest.create({}))
			.then((response) => callbacksRef.current.onTerminalProfiles(response.profiles))
			.catch((error) => console.error("Failed to fetch available terminal profiles:", error))

		return () => {
			for (const unsubscribe of unsubscribers) {
				unsubscribe()
			}
		}
	}, [])

	return { onRelinquishControl }
}
