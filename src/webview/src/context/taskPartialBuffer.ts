import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { buildTaskMessageIndex, normalizeTaskMessages } from "./taskMessageNormalization"

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

export function mergeTaskPartial(messages: readonly ClineMessage[], partialMessage: ClineMessage): ClineMessage[] {
	const normalized = normalizeTaskMessages([...messages])
	const index = buildTaskMessageIndex(normalized).get(partialMessage.ts) ?? -1
	const existing = index >= 0 ? normalized[index] : undefined
	if (!existing) {
		const next = [...normalized]
		next.splice(insertionIndex(next, partialMessage.ts), 0, partialMessage)
		return next
	}
	if (existing.partial === true && partialMessage.partial === true && (existing.text?.length ?? 0) > (partialMessage.text?.length ?? 0)) return messages as ClineMessage[]
	const next = [...normalized]
	next[index] = partialMessage
	return next
}

function insertionIndex(messages: readonly ClineMessage[], timestamp: number) {
	let low = 0, high = messages.length
	while (low < high) {
		const middle = (low + high) >>> 1
		if ((messages[middle].ts ?? 0) <= timestamp) low = middle + 1
		else high = middle
	}
	return low
}
