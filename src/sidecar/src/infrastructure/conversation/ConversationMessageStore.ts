import {
	isMeaninglessPlaceholderMessage,
	isMeaninglessTextMessage,
	isMeaninglessToolMessage,
	normalizeClineMessagePayload,
} from "./ConversationMessageProjection"

type Message = Record<string, unknown>

type ConversationMessageStoreCallbacks = {
	read: () => Message[]
	write: (messages: Message[]) => void
	persist: () => void
	publishPartial: (message: Message) => void
	log: (event: string, details: unknown) => void
}

export class ConversationMessageStore {
	private sequence = 0

	constructor(private readonly callbacks: ConversationMessageStoreCallbacks) {}

	nextTimestamp() {
		return Date.now() + this.sequence++
	}

	add(message: Message) {
		if (this.isMeaningless(message)) {
			return undefined
		}

		const normalized = {
			ts: this.nextTimestamp(),
			...normalizeClineMessagePayload(message),
		}
		this.callbacks.read().push(normalized)
		this.callbacks.persist()
		return normalized
	}

	removeTerminalAsks() {
		const terminalAskKinds = new Set(["completion_result", "resume_task", "resume_completed_task"])
		this.removeWhere((message) => terminalAskKinds.has(readString(message.ask)))
	}

	removeAsks(askKind: string) {
		this.removeWhere((message) => readString(message.ask) === askKind)
	}

	upsert(timestamp: number, updates: Message) {
		const messages = this.callbacks.read()
		const index = messages.findIndex((message) => message.ts === timestamp)
		if (index < 0) {
			return
		}

		const normalized = normalizeClineMessagePayload({ ...messages[index], ...updates, ts: timestamp })
		if (this.isMeaningless(normalized)) {
			messages.splice(index, 1)
		} else {
			messages[index] = normalized
		}
		this.callbacks.persist()
	}

	finalizeOpenPartials() {
		let changed = false
		const messages = this.callbacks.read().filter((message) => {
			if (message.partial !== true) {
				return true
			}

			if (message.say === "api_req_started" && isPlaceholderApiRequest(readString(message.text))) {
				changed = true
				return false
			}

			message.partial = false
			if (message.say === "api_req_started" || message.say === "reasoning") {
				message.isCollapsed = true
				message.isExpanded = false
			}
			this.callbacks.publishPartial(message)
			changed = true
			return true
		})

		if (changed) {
			this.callbacks.write(messages)
			this.callbacks.log("finalizedOpenPartials", {})
			this.callbacks.persist()
		}
		return changed
	}

	private removeWhere(predicate: (message: Message) => boolean) {
		this.callbacks.write(this.callbacks.read().filter((message) => !predicate(message)))
		this.callbacks.persist()
	}

	private isMeaningless(message: Message) {
		if (isMeaninglessPlaceholderMessage(message)) {
			this.callbacks.log("skipMeaninglessPlaceholderMessage", message)
			return true
		}
		if (isMeaninglessTextMessage(message)) {
			this.callbacks.log("skipMeaninglessTextMessage", message)
			return true
		}
		if (isMeaninglessToolMessage(message)) {
			this.callbacks.log("skipMeaninglessToolMessage", message)
			return true
		}
		return false
	}
}

function readString(value: unknown) {
	return typeof value === "string" ? value : value == null ? "" : String(value)
}

function isPlaceholderApiRequest(text: string) {
	let request = text
	try {
		const parsed: unknown = JSON.parse(text)
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			request = readString((parsed as Record<string, unknown>).request) || text
		}
	} catch {
		// Plain-text request status.
	}
	const normalized = request.replace(/\s+/g, " ").trim().toLowerCase()
	return normalized === "cline sdk is thinking..." ||
		normalized === "thinking" ||
		normalized === "모델 진행 중" ||
		normalized === "모델 진행 기록"
}
