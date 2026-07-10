import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { deriveRequestPendingState, type RequestPendingState } from "./requestPendingState"

const idle: RequestPendingState = { taskKey: "", turnTs: 0, pending: false }
const message = (value: Partial<ClineMessage> & Pick<ClineMessage, "ts" | "type">) => value as ClineMessage

describe("deriveRequestPendingState", () => {
	it("keeps a request pending between streaming and tool phases", () => {
		const user = message({ ts: 1, type: "say", say: "task", text: "inspect" })
		const streaming = message({ ts: 2, type: "say", say: "api_req_started", partial: true, text: "{}" })
		const active = deriveRequestPendingState(idle, "task-1", [user, streaming])
		expect(active.pending).toBe(true)

		const toolResult = message({ ts: 3, type: "say", say: "text", text: "tool result" })
		expect(deriveRequestPendingState(active, "task-1", [user, toolResult]).pending).toBe(true)
	})

	it("starts a new turn immediately and settles only on a terminal message", () => {
		const firstUser = message({ ts: 1, type: "say", say: "task", text: "hello" })
		const completed = message({ ts: 2, type: "say", say: "completion_result", text: "done" })
		const settled = deriveRequestPendingState(idle, "task-1", [firstUser, completed])
		expect(settled.pending).toBe(false)

		const nextUser = message({ ts: 3, type: "say", say: "user_feedback", text: "continue" })
		const nextTurn = deriveRequestPendingState(settled, "task-1", [firstUser, completed, nextUser])
		expect(nextTurn.pending).toBe(true)
		expect(
			deriveRequestPendingState(nextTurn, "task-1", [
				firstUser,
				completed,
				nextUser,
				message({ ts: 4, type: "say", say: "completion_result", text: "done again" }),
			]).pending,
		).toBe(false)
	})

	it("releases pending state for user interaction and cancellation", () => {
		const user = message({ ts: 1, type: "say", say: "task", text: "inspect" })
		const active: RequestPendingState = { taskKey: "task-1", turnTs: 1, pending: true }
		const followup = message({ ts: 2, type: "ask", ask: "followup", partial: false })
		expect(deriveRequestPendingState(active, "task-1", [user, followup]).pending).toBe(false)

		const cancelled = message({
			ts: 3,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ cancelReason: "user_cancelled" }),
		})
		expect(deriveRequestPendingState(active, "task-1", [user, cancelled]).pending).toBe(false)
	})
})
