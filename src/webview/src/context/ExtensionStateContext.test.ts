import type { ClineMessage, ExtensionState } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { mergeLivePartialMessages } from "./ExtensionStateContext"

const state = (messages: ClineMessage[]): ExtensionState =>
	({ currentTaskItem: { id: "task-1" }, clineMessages: messages }) as ExtensionState

describe("mergeLivePartialMessages", () => {
	it("preserves the live transcript when an empty same-task snapshot arrives", () => {
		const messages = [{ ts: 1, type: "say", say: "task", text: "hello" }] as ClineMessage[]
		expect(mergeLivePartialMessages(state(messages), state([])).clineMessages).toEqual(messages)
	})

	it("preserves newer messages and longer partial text from a stale snapshot", () => {
		const previous = state([
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 3, type: "say", say: "text", text: "tool result" },
			{ ts: 4, type: "say", say: "text", partial: true, text: "long response" },
		] as ClineMessage[])
		const incoming = state([
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 4, type: "say", say: "text", partial: true, text: "short" },
		] as ClineMessage[])
		const merged = mergeLivePartialMessages(previous, incoming).clineMessages
		expect(merged.some((message) => message.ts === 3)).toBe(true)
		expect(merged.find((message) => message.ts === 4)?.text).toBe("long response")
	})

	it("accepts a terminal snapshot as authoritative", () => {
		const previous = state([{ ts: 1, type: "say", say: "task" }, { ts: 3, type: "say", say: "text" }] as ClineMessage[])
		const terminal = state([{ ts: 1, type: "say", say: "task" }, { ts: 4, type: "say", say: "completion_result" }] as ClineMessage[])
		expect(mergeLivePartialMessages(previous, terminal)).toBe(terminal)
	})
})
