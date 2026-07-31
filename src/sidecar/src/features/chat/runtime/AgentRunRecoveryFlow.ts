type Callbacks = Readonly<{
	currentGeneration: () => number
	isTerminal: () => boolean
	activeText: () => string
	hasAssistantText: () => boolean
	hydrate: (sessionId: string, source: string) => Promise<boolean>
	sessionStatus: (sessionId: string) => Promise<string>
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
		if (this.callbacks.isTerminal()) {
			this.callbacks.log("sdkRunErrorRecoverySkippedTerminal", { source, sessionId, runGeneration })
			return
		}
		const currentRunGeneration = this.callbacks.currentGeneration()
		if (runGeneration && runGeneration !== currentRunGeneration) {
			this.callbacks.log("sdkRunErrorRecoveryCancelled", { source, sessionId, runGeneration, currentRunGeneration })
			return
		}
		if (await this.callbacks.hydrate(sessionId, `error:${source}`) && this.callbacks.isTerminal()) {
			this.callbacks.updateTask()
			await this.callbacks.broadcast()
			this.callbacks.log("sdkRunErrorRecoveredByTerminalHydration", { source, sessionId })
			return
		}
		const sessionStatus = (await this.callbacks.sessionStatus(sessionId).catch(() => "")).trim().toLowerCase()
		if (isActiveSessionStatus(sessionStatus)) {
			this.callbacks.log("sdkRunErrorRecoveryDeferredToActiveSession", { source, sessionId, sessionStatus })
			this.callbacks.updateTask()
			await this.callbacks.broadcast()
			return
		}
		this.callbacks.log("sdkRunErrorRecoveryConfirmedFailure", { source, sessionId, sessionStatus: sessionStatus || "unknown", activeTextLength: this.callbacks.activeText().length, hasAssistantText: this.callbacks.hasAssistantText() })
		this.callbacks.projectFailure(source, error)
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
	}
}

function isActiveSessionStatus(status: string) { return ["active", "running", "starting", "streaming", "pending", "in_progress", "in-progress", "awaiting_user"].includes(status) }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
