type Callbacks = Readonly<{
	currentGeneration: () => number
	activeText: () => string
	hasAssistantText: () => boolean
	hydrate: (sessionId: string, source: string) => Promise<boolean>
	finishTask: (sessionId: string, status: string, text: string) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	projectFailure: (source: string, error: unknown) => void
	log: (event: string, details: Record<string, unknown>) => void
}>

export class AgentRunRecoveryFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async recover(sessionId: string, source: string, runGeneration: number, error: unknown) {
		this.callbacks.log("sdkRunErrorRecoveryStarted", { source, sessionId, runGeneration, error: stringify(error), activePartialTextLength: this.callbacks.activeText().length, hasAssistantTextAfterLastUserMessage: this.callbacks.hasAssistantText() })
		for (const delayMs of [0, 500, 1500, 3000]) {
			const currentRunGeneration = this.callbacks.currentGeneration()
			if (runGeneration && runGeneration !== currentRunGeneration) {
				this.callbacks.log("sdkRunErrorRecoveryCancelled", { source, sessionId, runGeneration, currentRunGeneration })
				return
			}
			if (delayMs > 0) await delay(delayMs)
			if (await this.callbacks.hydrate(sessionId, `error:${source}:${delayMs}`)) {
				this.callbacks.updateTask()
				await this.callbacks.broadcast()
				this.callbacks.log("sdkRunErrorRecoveredByHydration", { source, sessionId, delayMs })
				return
			}
		}
		const activeText = this.callbacks.activeText()
		if (activeText || this.callbacks.hasAssistantText()) {
			this.callbacks.finishTask(sessionId, "completed", activeText)
			this.callbacks.updateTask()
			await this.callbacks.broadcast()
			this.callbacks.log("sdkRunErrorRecoveredByPartialText", { source, sessionId, activeTextLength: activeText.length })
			return
		}
		this.callbacks.projectFailure(source, error)
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
	}
}

function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)) }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
