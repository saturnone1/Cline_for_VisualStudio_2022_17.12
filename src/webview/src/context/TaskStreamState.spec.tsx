import type { ClineMessage, ExtensionState } from "@shared/ExtensionMessage"
import { ClineAsk, ClineMessageType, ClineSay } from "@shared/proto/cline/ui"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { vi } from "vitest"
import type { ExtensionSubscriptionCallbacks } from "./ExtensionSubscriptions"
import { NavigationStateProvider } from "./NavigationState"
import { RuntimeViewStateProvider } from "./RuntimeViewState"
import { mergeLivePartialMessages, TaskStreamStateProvider, useLiveTaskMessages, useTaskBaseStateContext, useTaskStreamStateContext } from "./TaskStreamState"

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
	it("drops null message entries from incoming state snapshots", async () => {
		const { result } = renderHook(() => useTaskStreamStateContext(), { wrapper })

		act(() => subscriptionCallbacks?.onStateJson(JSON.stringify({
			version: "null-message-test",
			clineMessages: [null as unknown as ClineMessage],
			taskHistory: [],
			welcomeViewCompleted: true,
		} as ExtensionState)))

		expect(result.current.state.clineMessages).toEqual([])
	})
	it("does not let an older multi-turn snapshot shorten the current live partial", () => {
		const previous = {
			currentTaskItem: { id: "task-1" },
			clineMessages: [
				{ ts: 1, type: "say", say: "task", text: "first" },
				{ ts: 2, type: "say", say: "completion_result", text: "Done." },
				{ ts: 3, type: "say", say: "user_feedback", text: "second" },
				{ ts: 4, type: "say", say: "text", text: "a longer live answer", partial: true },
			],
		} as ExtensionState
		const incoming = {
			...previous,
			clineMessages: [...previous.clineMessages.slice(0, -1), { ts: 4, type: "say", say: "text", text: "short", partial: true }],
		} as ExtensionState

		expect(mergeLivePartialMessages(previous, incoming).clineMessages.at(-1)?.text).toBe("a longer live answer")
	})

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

	it("keeps partial updates out of the base application state", () => {
		const { result } = renderHook(() => ({ base: useTaskBaseStateContext(), live: useLiveTaskMessages() }), { wrapper })
		act(() => subscriptionCallbacks?.onStateJson(JSON.stringify({
			version: "stream-test", currentTaskItem: { id: "task-1" }, clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }], taskHistory: [], welcomeViewCompleted: true,
		} as ExtensionState)))
		act(() => subscriptionCallbacks?.onPartialMessage({
			taskId: "task-1",
			message: { ts: 2, type: ClineMessageType.SAY, ask: ClineAsk.UNRECOGNIZED, say: ClineSay.TEXT, text: "partial", reasoning: "",
				images: [], files: [], partial: true, lastCheckpointHash: "", isCheckpointCheckedOut: false,
				isOperationOutsideWorkspace: false, conversationHistoryIndex: 0 },
		}))

		expect(result.current.live).toHaveLength(2)
		expect(result.current.base.state.clineMessages).toHaveLength(1)
	})

	it("ignores a delayed partial owned by a different task", () => {
		const { result } = renderHook(() => useLiveTaskMessages(), { wrapper })
		act(() => subscriptionCallbacks?.onStateJson(JSON.stringify({
			version: "stream-test", currentTaskItem: { id: "task-2" }, clineMessages: [{ ts: 1, type: "say", say: "task", text: "current" }], taskHistory: [], welcomeViewCompleted: true,
		} as ExtensionState)))
		act(() => subscriptionCallbacks?.onPartialMessage({
			taskId: "task-1",
			message: { ts: 2, type: ClineMessageType.SAY, ask: ClineAsk.UNRECOGNIZED, say: ClineSay.TEXT, text: "stale", reasoning: "", images: [], files: [], partial: true, lastCheckpointHash: "", isCheckpointCheckedOut: false, isOperationOutsideWorkspace: false, conversationHistoryIndex: 0 },
		}))
		expect(result.current).toHaveLength(1)
		expect(result.current[0].text).toBe("current")
	})

	it("replays a partial that arrived before its task state rebind", () => {
		const { result } = renderHook(() => useLiveTaskMessages(), { wrapper })
		act(() => subscriptionCallbacks?.onStateJson(JSON.stringify({
			version: "stream-test", currentTaskItem: { id: "temporary" }, clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }], taskHistory: [], welcomeViewCompleted: true,
		} as ExtensionState)))
		act(() => subscriptionCallbacks?.onPartialMessage({
			taskId: "sdk-session", message: { ts: 2, type: ClineMessageType.SAY, ask: ClineAsk.UNRECOGNIZED, say: ClineSay.TEXT, text: "first partial", reasoning: "", images: [], files: [], partial: true, lastCheckpointHash: "", isCheckpointCheckedOut: false, isOperationOutsideWorkspace: false, conversationHistoryIndex: 0 },
		}))
		act(() => subscriptionCallbacks?.onStateJson(JSON.stringify({
			version: "stream-test", currentTaskItem: { id: "sdk-session" }, clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }], taskHistory: [], welcomeViewCompleted: true,
		} as ExtensionState)))
		expect(result.current.at(-1)?.text).toBe("first partial")
	})
})
