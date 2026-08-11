import { act, renderHook, waitFor } from "@testing-library/react"
import { vi } from "vitest"
import { useExtensionSubscriptions } from "./ExtensionSubscriptions"

const mocks = vi.hoisted(() => {
	const handlers: Record<string, { onResponse: (value: unknown) => void }> = {}
	const unsubscribe = vi.fn()
	const stream = (name: string) =>
		vi.fn((_request: unknown, callbacks: { onResponse: (value: unknown) => void }) => {
			handlers[name] = callbacks
			return unsubscribe
		})
	return { handlers, unsubscribe, stream }
})

vi.mock("../services/grpcClient", () => ({
	StateServiceClient: {
		subscribeToState: mocks.stream("state"),
		getAvailableTerminalProfiles: vi.fn(() => Promise.resolve({ profiles: [{ id: "pwsh" }] })),
	},
	UiServiceClient: {
		initializeWebview: vi.fn(() => Promise.resolve({})),
		subscribeToMcpButtonClicked: mocks.stream("mcp"),
		subscribeToHistoryButtonClicked: mocks.stream("history"),
		subscribeToChatButtonClicked: mocks.stream("chat"),
		subscribeToSettingsButtonClicked: mocks.stream("settings"),
		subscribeToWorktreesButtonClicked: mocks.stream("worktrees"),
		subscribeToPartialMessage: mocks.stream("partial"),
		subscribeToAccountButtonClicked: mocks.stream("account"),
		subscribeToRelinquishControl: mocks.stream("relinquish"),
	},
}))

function createCallbacks(onStateJson = vi.fn()) {
	return {
		onStateJson,
		onPartialMessage: vi.fn(),
		onTerminalProfiles: vi.fn(),
		navigateToMcp: vi.fn(),
		navigateToHistory: vi.fn(),
		navigateToChat: vi.fn(),
		navigateToSettings: vi.fn(),
		navigateToWorktrees: vi.fn(),
		navigateToAccount: vi.fn(),
	}
}

describe("useExtensionSubscriptions", () => {
	it("registers all streams once, uses current callbacks, and disposes every stream", async () => {
		const firstStateHandler = vi.fn()
		const { rerender, unmount } = renderHook(
			({ callbacks }) => useExtensionSubscriptions(callbacks),
			{ initialProps: { callbacks: createCallbacks(firstStateHandler) } },
		)

		expect(Object.keys(mocks.handlers).sort()).toEqual([
			"account",
			"chat",
			"history",
			"mcp",
			"partial",
			"relinquish",
			"settings",
			"state",
			"worktrees",
		])

		const latestStateHandler = vi.fn()
		rerender({ callbacks: createCallbacks(latestStateHandler) })
		act(() => mocks.handlers.state.onResponse({ stateJson: "{}" }))
		expect(firstStateHandler).not.toHaveBeenCalled()
		expect(latestStateHandler).toHaveBeenCalledWith("{}")

		await waitFor(() => expect(Object.keys(mocks.handlers)).toHaveLength(9))
		unmount()
		expect(mocks.unsubscribe).toHaveBeenCalledTimes(9)
	})
})
