import type { ExtensionState } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { vi } from "vitest"
import type { ExtensionSubscriptionCallbacks } from "./ExtensionSubscriptions"
import { NavigationStateProvider } from "./NavigationState"
import { RuntimeViewStateProvider } from "./RuntimeViewState"
import { TaskStreamStateProvider, useTaskStreamStateContext } from "./TaskStreamState"

let subscriptionCallbacks: ExtensionSubscriptionCallbacks | undefined

vi.mock("./ExtensionSubscriptions", () => ({
	useExtensionSubscriptions: (callbacks: ExtensionSubscriptionCallbacks) => {
		subscriptionCallbacks = callbacks
		return { onRelinquishControl: vi.fn(() => vi.fn()) }
	},
}))

function wrapper({ children }: { children: ReactNode }) {
	return (
		<NavigationStateProvider>
			<RuntimeViewStateProvider>
				<TaskStreamStateProvider>{children}</TaskStreamStateProvider>
			</RuntimeViewStateProvider>
		</NavigationStateProvider>
	)
}

describe("TaskStreamStateProvider", () => {
	it("owns initial state and applies the subscribed hydration snapshot", () => {
		const { result } = renderHook(() => useTaskStreamStateContext(), { wrapper })
		expect(result.current.state.clineMessages).toEqual([])
		expect(result.current.didHydrateState).toBe(false)

		const snapshot = {
			version: "provider-test",
			clineMessages: [],
			taskHistory: [],
			preferredLanguage: "English",
			welcomeViewCompleted: true,
		} as ExtensionState
		act(() => subscriptionCallbacks?.onStateJson(JSON.stringify(snapshot)))

		expect(result.current.state.version).toBe("provider-test")
		expect(result.current.state.uiLanguage).toBe("en")
		expect(result.current.didHydrateState).toBe(true)
	})
})
