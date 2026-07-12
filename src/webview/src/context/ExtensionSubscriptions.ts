import { EmptyRequest } from "@shared/proto/cline/common"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { useCallback, useEffect, useRef } from "react"
import { StateServiceClient, UiServiceClient } from "../services/grpcClient"

interface ExtensionSubscriptionCallbacks {
	onStateJson: (stateJson: string) => void
	onPartialMessage: (message: ProtoClineMessage) => void
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
	const stateGenerationRef = useRef(0)
	const partialMessageGenerationRef = useRef(0)
	const relinquishControlCallbacks = useRef<Set<() => void>>(new Set())

	const onRelinquishControl = useCallback((callback: () => void) => {
		relinquishControlCallbacks.current.add(callback)
		return () => relinquishControlCallbacks.current.delete(callback)
	}, [])

	useEffect(() => {
		const stateGeneration = ++stateGenerationRef.current
		const partialMessageGeneration = ++partialMessageGenerationRef.current
		const unsubscribers: Array<() => void> = []

		unsubscribers.push(
			StateServiceClient.subscribeToState(EmptyRequest.create({}), {
				onResponse: (response) => {
					if (stateGenerationRef.current === stateGeneration && response.stateJson) {
						callbacksRef.current.onStateJson(response.stateJson)
					}
				},
				onError: (error) => console.error("Error in state subscription:", error),
				onComplete: () => console.log("State subscription completed"),
			}),
			UiServiceClient.subscribeToMcpButtonClicked({}, {
				onResponse: () => callbacksRef.current.navigateToMcp(),
				onError: (error) => console.error("Error in mcpButtonClicked subscription:", error),
				onComplete: () => console.log("mcpButtonClicked subscription completed"),
			}),
			UiServiceClient.subscribeToHistoryButtonClicked({}, {
				onResponse: () => callbacksRef.current.navigateToHistory(),
				onError: (error) => console.error("Error in history button clicked subscription:", error),
				onComplete: () => console.log("History button clicked subscription completed"),
			}),
			UiServiceClient.subscribeToChatButtonClicked({}, {
				onResponse: () => callbacksRef.current.navigateToChat(),
				onError: (error) => console.error("Error in chat button subscription:", error),
				onComplete: () => undefined,
			}),
			UiServiceClient.subscribeToSettingsButtonClicked(EmptyRequest.create({}), {
				onResponse: () => callbacksRef.current.navigateToSettings(),
				onError: (error) => console.error("Error in settings button clicked subscription:", error),
				onComplete: () => console.log("Settings button clicked subscription completed"),
			}),
			UiServiceClient.subscribeToWorktreesButtonClicked(EmptyRequest.create({}), {
				onResponse: () => callbacksRef.current.navigateToWorktrees(),
				onError: (error) => console.error("Error in worktrees button clicked subscription:", error),
				onComplete: () => console.log("Worktrees button clicked subscription completed"),
			}),
			UiServiceClient.subscribeToPartialMessage(EmptyRequest.create({}), {
				onResponse: (message) => {
					if (partialMessageGenerationRef.current === partialMessageGeneration) {
						callbacksRef.current.onPartialMessage(message)
					}
				},
				onError: (error) => console.error("Error in partialMessage subscription:", error),
				onComplete: () => console.log("Partial message subscription completed"),
			}),
			UiServiceClient.subscribeToAccountButtonClicked(EmptyRequest.create({}), {
				onResponse: () => callbacksRef.current.navigateToAccount(),
				onError: (error) => console.error("Error in account button clicked subscription:", error),
				onComplete: () => console.log("Account button clicked subscription completed"),
			}),
			UiServiceClient.subscribeToRelinquishControl(EmptyRequest.create({}), {
				onResponse: () => relinquishControlCallbacks.current.forEach((callback) => callback()),
				onError: (error) => console.error("Error in relinquishControl subscription:", error),
				onComplete: () => undefined,
			}),
		)

		UiServiceClient.initializeWebview(EmptyRequest.create({})).catch((error) => {
			console.error("Failed to initialize webview via gRPC:", error)
		})
		StateServiceClient.getAvailableTerminalProfiles(EmptyRequest.create({}))
			.then((response) => callbacksRef.current.onTerminalProfiles(response.profiles))
			.catch((error) => console.error("Failed to fetch available terminal profiles:", error))

		return () => {
			stateGenerationRef.current++
			partialMessageGenerationRef.current++
			for (const unsubscribe of unsubscribers) {
				unsubscribe()
			}
		}
	}, [])

	return { onRelinquishControl }
}
