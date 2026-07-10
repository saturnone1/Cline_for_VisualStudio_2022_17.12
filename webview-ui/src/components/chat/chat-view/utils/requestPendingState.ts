import type { ClineMessage } from "@shared/ExtensionMessage"

export type RequestPendingState = {
	taskKey: string
	turnTs: number
	pending: boolean
}

const IDLE_REQUEST_STATE: RequestPendingState = { taskKey: "", turnTs: 0, pending: false }

function isActiveApiRequest(message: ClineMessage) {
	if (message.type !== "say" || message.say !== "api_req_started") {
		return false
	}
	try {
		const info = JSON.parse(message.text || "{}")
		const hasUsage = ["cost", "totalCost", "tokensIn", "tokensOut", "cacheWrites", "cacheReads"].some(
			(key) => typeof info[key] === "number",
		)
		return !info.cancelReason && !info.streamingFailedMessage && !hasUsage
	} catch {
		return true
	}
}

function isCancelledApiRequest(message: ClineMessage) {
	if (message.type !== "say" || message.say !== "api_req_started") {
		return false
	}
	try {
		const info = JSON.parse(message.text || "{}")
		return Boolean(info.cancelReason)
	} catch {
		return false
	}
}

function isTerminalTaskMessage(message: ClineMessage) {
	return (
		(message.type === "say" && (message.say === "completion_result" || message.say === "error")) ||
		(message.type === "ask" && message.ask === "completion_result")
	)
}

function isAwaitingUserMessage(message: ClineMessage | undefined) {
	return message?.type === "ask" && message.partial !== true && message.ask !== "completion_result"
}

export function deriveRequestPendingState(
	previous: RequestPendingState,
	taskKey: string,
	messages: ClineMessage[],
): RequestPendingState {
	if (!taskKey || messages.length === 0) {
		return IDLE_REQUEST_STATE
	}

	let lastUserIndex = -1
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.type === "say" && (message.say === "user_feedback" || message.say === "task")) {
			lastUserIndex = index
			break
		}
	}

	const turnTs = lastUserIndex >= 0 ? messages[lastUserIndex].ts ?? 0 : 0
	const activeTurnMessages = messages.slice(lastUserIndex + 1)
	const lastMessage = messages.at(-1)
	const settled =
		activeTurnMessages.some(isTerminalTaskMessage) ||
		activeTurnMessages.some(isCancelledApiRequest) ||
		isAwaitingUserMessage(lastMessage)
	const hasActivity = activeTurnMessages.some((message) => message.partial === true || isActiveApiRequest(message))
	const taskChanged = previous.taskKey !== taskKey
	const turnChanged = !taskChanged && previous.turnTs !== turnTs

	const pending = settled ? false : taskChanged ? hasActivity : turnChanged || hasActivity ? true : previous.pending
	if (previous.taskKey === taskKey && previous.turnTs === turnTs && previous.pending === pending) {
		return previous
	}
	return { taskKey, turnTs, pending }
}
