import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"

const MAX_TASKS = 4
const MAX_MESSAGES_PER_TASK = 200

export class TaskPartialBuffer {
	private readonly tasks = new Map<string, Map<number, ProtoClineMessage>>()

	add(taskId: string, message: ProtoClineMessage) {
		if (!taskId || !message.ts || message.ts <= 0) return
		let messages = this.tasks.get(taskId)
		if (!messages) { messages = new Map(); this.tasks.set(taskId, messages) }
		messages.set(message.ts, message)
		while (messages.size > MAX_MESSAGES_PER_TASK) messages.delete(messages.keys().next().value as number)
		while (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value as string)
	}

	take(taskId: string) {
		const messages = this.tasks.get(taskId)
		if (!messages) return []
		this.tasks.delete(taskId)
		return [...messages.values()]
	}
}

export function mergeTaskPartial(
	messages: readonly ClineMessage[],
	partialMessage: ClineMessage,
	indexByTimestamp?: Map<number, number>,
): ClineMessage[] {
	let index = indexByTimestamp?.get(partialMessage.ts) ?? -1
	if (index < 0 || messages[index]?.ts !== partialMessage.ts) {
		index = messages.findIndex((message) => message.ts === partialMessage.ts)
		if (index >= 0) indexByTimestamp?.set(partialMessage.ts, index)
	}
	const existing = index >= 0 ? messages[index] : undefined
	if (!existing) {
		indexByTimestamp?.set(partialMessage.ts, messages.length)
		return [...messages, partialMessage]
	}
	if (existing.partial === true && partialMessage.partial === true && (existing.text?.length ?? 0) > (partialMessage.text?.length ?? 0)) return messages as ClineMessage[]
	const next = [...messages]
	next[index] = partialMessage
	return next
}
