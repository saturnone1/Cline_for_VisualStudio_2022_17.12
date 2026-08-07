export type DecodedAgentRunResult = Readonly<{ sessionId: string; empty: boolean; text: string; finishReason: string }>

type Callbacks = Readonly<{
	decode: (result: unknown, fallbackSessionId: string) => DecodedAgentRunResult
	currentGeneration: () => number
	currentTaskId: () => string
	activeSessionId: () => string
	bindSession: (sessionId: string) => void
	isCurrentSession: (sessionId: string) => boolean
	hydrate: (sessionId: string, source: string) => Promise<boolean>
	noteRunSucceeded: (sessionId: string) => void
	activeText: () => string
	hasAssistantText: () => boolean
	lastActivityReason: () => string
	finishTask: (sessionId: string, status: string, text: string) => void
	failEmpty: (sessionId: string) => void
	finalizePartial: () => void
	addCompletionMarker: (status: string) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class AgentRunCompletionFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async complete(result: unknown, fallbackSessionId: string, source: string, runGeneration: number) {
		const decoded = this.callbacks.decode(result, fallbackSessionId)
		const { sessionId } = decoded
		const currentRunGeneration = this.callbacks.currentGeneration()
		if (runGeneration !== currentRunGeneration) {
			this.callbacks.log("ignoredSupersededSdkResult", { source, sessionId, runGeneration, currentRunGeneration })
			return
		}
		if (sessionId && fallbackSessionId && sessionId !== fallbackSessionId && this.callbacks.currentTaskId() === fallbackSessionId) this.callbacks.bindSession(sessionId)
		if (!this.callbacks.isCurrentSession(sessionId)) {
			this.callbacks.log("ignoredStaleSdkResult", { source, sessionId, currentTaskId: this.callbacks.currentTaskId(), activeSessionId: this.callbacks.activeSessionId() })
			return
		}
		// The run reached the sidecar intact, so the provider is reachable and any
		// retry budget spent on earlier transport faults is released.
		this.callbacks.noteRunSucceeded(sessionId)
		await this.callbacks.hydrate(sessionId, `complete:${source}`)

		if (decoded.empty) {
			const activeText = this.callbacks.activeText()
			const hasAssistantText = this.callbacks.hasAssistantText()
			this.callbacks.log("emptySdkResult", { source, sessionId, lastTaskActivityReason: this.callbacks.lastActivityReason(), activePartialTextLength: activeText.length, hasAssistantTextAfterLastUserMessage: hasAssistantText })
			if (activeText || hasAssistantText) {
				this.callbacks.finishTask(sessionId, "completed", activeText)
				this.callbacks.updateTask()
				await this.callbacks.broadcast()
			} else if (await this.callbacks.hydrate(sessionId, `empty:${source}`)) await this.callbacks.broadcast()
			else {
				this.callbacks.failEmpty(sessionId)
				this.callbacks.updateTask()
				await this.callbacks.broadcast()
			}
			return
		}

		if (decoded.text) this.callbacks.finishTask(sessionId, decoded.finishReason, decoded.text)
		else if (!this.callbacks.hasAssistantText()) {
			this.callbacks.log("emptySdkResultNoAssistantText", { source, sessionId, finishReason: decoded.finishReason, lastTaskActivityReason: this.callbacks.lastActivityReason() })
			this.callbacks.failEmpty(sessionId)
		} else {
			this.callbacks.finalizePartial()
			this.callbacks.addCompletionMarker(decoded.finishReason)
		}
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
	}
}
