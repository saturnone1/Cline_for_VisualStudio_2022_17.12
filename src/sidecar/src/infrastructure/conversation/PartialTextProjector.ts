import type { ConversationProjectionState } from "../../features/conversation/ConversationProjectionState"

type Message = Record<string, unknown>

export class PartialTextProjector {
	constructor(
		private readonly projection: ConversationProjectionState,
		private readonly messages: () => Message[],
		private readonly nextTimestamp: () => number,
		private readonly upsertMessage: (timestamp: number, updates: Message) => void,
		private readonly sendPartial: (message?: Message) => void,
		private readonly scheduleIdle: () => void,
		private readonly clearIdle: () => void,
		private readonly clearBroadcast: () => void,
		private readonly broadcastNow: () => void,
		private readonly scheduleBroadcast: () => void,
	) {}

	finalize() {
		this.clearIdle()
		this.clearBroadcast()
		const timestamp = this.projection.activePartialTextTs
		if (!timestamp) return
		const message = this.messages().find((item) => item.ts === timestamp)
		if (message) { message.partial = false; this.sendPartial(message) }
		this.projection.activePartialTextTs = null
	}

	activeText() {
		const timestamp = this.projection.activePartialTextTs
		if (!timestamp) return ""
		return readString(this.messages().find((item) => item.ts === timestamp)?.text)
	}

	upsert(text: string) {
		let created = false
		if (!this.projection.activePartialTextTs) {
			created = true
			this.projection.activePartialTextTs = this.nextTimestamp()
			this.messages().push({ ts: this.projection.activePartialTextTs, type: "say", say: "text", text, partial: true })
		} else {
			this.upsertMessage(this.projection.activePartialTextTs, { type: "say", say: "text", text, partial: true })
		}
		this.scheduleIdle()
		if (created) this.broadcastNow()
		else { this.sendPartial(this.messages().find((message) => message.ts === this.projection.activePartialTextTs)); this.scheduleBroadcast() }
	}
}

function readString(value: unknown) { return typeof value === "string" ? value : "" }
