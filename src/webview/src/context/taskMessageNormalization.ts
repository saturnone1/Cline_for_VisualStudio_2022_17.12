import type { ClineMessage, ExtensionState } from "@shared/ExtensionMessage"

export function normalizeTaskMessages(messages: unknown): ClineMessage[] {
	if (!Array.isArray(messages)) return []
	const isMessage = (message: unknown): message is ClineMessage =>
		message !== null && typeof message === "object" && typeof (message as ClineMessage).type === "string"
	return messages.every(isMessage) ? messages : messages.filter(isMessage)
}

export function normalizeTaskStateMessages(state: ExtensionState): ExtensionState {
	const clineMessages = normalizeTaskMessages(state.clineMessages)
	return clineMessages === state.clineMessages ? state : { ...state, clineMessages }
}

export function buildTaskMessageIndex(messages: readonly ClineMessage[] | null | undefined) {
	return new Map(normalizeTaskMessages(messages).map((message, index) => [message.ts, index]))
}
