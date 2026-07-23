import { browserActionResultTextForSnapshot } from "../../features/browser/BrowserPolicy"

export const TRANSCRIPT_SNAPSHOT_LIMITS = Object.freeze({
	currentMessages: 600,
	snapshotMessages: 300,
	messageTextChars: 16 * 1024,
	currentTotalChars: 4 * 1024 * 1024,
})

export function projectTranscriptMessages(value: unknown, limit: number, maxTotalChars = TRANSCRIPT_SNAPSHOT_LIMITS.currentTotalChars) {
	if (!Array.isArray(value)) return []
	const selected = selectMessages(value, limit).map((item, index) => ({ index, message: normalizeMessage(item) }))
	if (!Number.isFinite(maxTotalChars) || maxTotalChars <= 0) return selected.map((item) => item.message)

	const required = new Set<number>()
	if (selected.length > 0) required.add(0)
	for (let index = selected.length - 1; index >= 0; index--) {
		if (asRecord(selected[index].message).contextCompaction) { required.add(index); break }
	}

	const retained = new Set<number>(required)
	let usedChars = [...required].reduce((total, index) => total + serializedSize(selected[index].message), 2)
	for (let index = selected.length - 1; index >= 0; index--) {
		if (retained.has(index)) continue
		const size = serializedSize(selected[index].message)
		if (retained.size > 0 && usedChars + size > maxTotalChars) continue
		retained.add(index)
		usedChars += size
	}
	return [...retained].sort((left, right) => left - right).map((index) => selected[index].message)
}

function selectMessages(messages: unknown[], limit: number) {
	const boundedLimit = Math.max(1, Math.floor(limit))
	if (messages.length <= boundedLimit) return messages
	const anchorIndexes = new Set<number>([0])
	for (let index = messages.length - 1; index >= 0; index--) {
		if (asRecord(messages[index]).contextCompaction) { anchorIndexes.add(index); break }
	}
	const selectedIndexes = new Set<number>(anchorIndexes)
	for (let index = messages.length - 1; index >= 0 && selectedIndexes.size < boundedLimit; index--) selectedIndexes.add(index)
	return [...selectedIndexes].sort((left, right) => left - right).map((index) => messages[index])
}

function normalizeMessage(value: unknown) {
	const message = { ...asRecord(value) }
	for (const key of ["text", "reasoning"] as const) {
		if (key === "text" && message.say === "browser_action_result" && typeof message[key] === "string") {
			message[key] = browserActionResultTextForSnapshot(message[key])
			continue
		}
		if (typeof message[key] === "string" && message[key].length > TRANSCRIPT_SNAPSHOT_LIMITS.messageTextChars) {
			message[key] = `${message[key].slice(0, TRANSCRIPT_SNAPSHOT_LIMITS.messageTextChars)}\n[truncated in LIG VS transcript snapshot]`
		}
	}
	if (Array.isArray(message.images)) {
		message.images = message.images.slice(0, 4).map((image) => typeof image === "string" && image.startsWith("data:") ? "[image omitted from LIG VS transcript snapshot]" : image)
	}
	return message
}

function serializedSize(value: unknown) { try { return JSON.stringify(value).length + 1 } catch { return 1 } }
function asRecord(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
