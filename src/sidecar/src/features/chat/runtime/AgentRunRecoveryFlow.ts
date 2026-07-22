type Callbacks = Readonly<{
	currentGeneration: () => number
	isTerminal: () => boolean
	activeText: () => string
	hasAssistantText: () => boolean
	hydrate: (sessionId: string, source: string) => Promise<boolean>
	finishTask: (sessionId: string, status: string, text: string) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	projectFailure: (source: string, error: unknown) => void
	log: (event: string, details: Record<string, unknown>) => void
}>

export type AgentRunRecoveryPolicy = Readonly<{
	deadlineMs: number
	initialDelayMs: number
	maxDelayMs: number
	now?: () => number
	wait?: (ms: number) => Promise<void>
}>

export class AgentRunRecoveryFlow {
	constructor(
		private readonly callbacks: Callbacks,
		private readonly policy: AgentRunRecoveryPolicy = { deadlineMs: 15_000, initialDelayMs: 250, maxDelayMs: 2_000 },
	) {}

	async recover(sessionId: string, source: string, runGeneration: number, error: unknown) {
		this.callbacks.log("sdkRunErrorRecoveryStarted", { source, sessionId, runGeneration, error: stringify(error), activePartialTextLength: this.callbacks.activeText().length, hasAssistantTextAfterLastUserMessage: this.callbacks.hasAssistantText() })
		if (this.callbacks.isTerminal()) {
			this.callbacks.log("sdkRunErrorRecoverySkippedTerminal", { source, sessionId, runGeneration })
			return
		}
		const now = this.policy.now ?? Date.now
		const wait = this.policy.wait ?? delay
		const deadline = now() + Math.max(0, this.policy.deadlineMs)
		let delayMs = 0
		let attempt = 0
		while (true) {
			const currentRunGeneration = this.callbacks.currentGeneration()
			if (runGeneration && runGeneration !== currentRunGeneration) {
				this.callbacks.log("sdkRunErrorRecoveryCancelled", { source, sessionId, runGeneration, currentRunGeneration })
				return
			}
			if (delayMs > 0) await wait(delayMs)
			if (runGeneration && runGeneration !== this.callbacks.currentGeneration()) {
				this.callbacks.log("sdkRunErrorRecoveryCancelled", { source, sessionId, runGeneration, currentRunGeneration: this.callbacks.currentGeneration() })
				return
			}
			if (await this.callbacks.hydrate(sessionId, `error:${source}:${delayMs}`) && this.callbacks.isTerminal()) {
				this.callbacks.updateTask()
				await this.callbacks.broadcast()
				this.callbacks.log("sdkRunErrorRecoveredByTerminalHydration", { source, sessionId, delayMs })
				return
			}
			if (now() >= deadline) break
			delayMs = attempt === 0
				? Math.max(1, this.policy.initialDelayMs)
				: Math.min(Math.max(1, this.policy.maxDelayMs), delayMs * 2)
			attempt++
			if (now() + delayMs > deadline) delayMs = Math.max(1, deadline - now())
		}
		this.callbacks.log("sdkRunErrorRecoveryExhausted", { source, sessionId, activeTextLength: this.callbacks.activeText().length, hasAssistantText: this.callbacks.hasAssistantText() })
		this.callbacks.projectFailure(source, error)
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
	}
}

function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)) }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
