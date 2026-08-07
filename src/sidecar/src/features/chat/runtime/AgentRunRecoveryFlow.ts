import type { RuntimeErrorRecoveryDecision } from "../../../application/services/RuntimeErrorRecoveryPolicy"

type Callbacks = Readonly<{
	currentGeneration: () => number
	isTerminal: () => boolean
	isStopping: () => boolean
	activeText: () => string
	hasAssistantText: () => boolean
	hydrate: (sessionId: string, source: string) => Promise<boolean>
	sessionStatus: (sessionId: string) => Promise<string>
	finishTask: (sessionId: string, status: string, text: string) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	decideRecovery: (sessionId: string, error: unknown) => RuntimeErrorRecoveryDecision
	retry: (sessionId: string, decision: Extract<RuntimeErrorRecoveryDecision, { action: "retry" }>) => Promise<boolean>
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
		// The run really did die. Before ending the task, give the agent a chance to
		// see the failure: a provider or transport fault carries no information about
		// the task itself, and terminating here is what made the sidecar look like it
		// had silently stopped.
		// Aborting an in-flight stream surfaces as a transport fault ("socket hang up",
		// "premature close"), and the cancel flow only advances the run generation once
		// cancellation has settled. Without this guard a stop request would be answered
		// by restarting the very run the user asked to stop.
		const decision = this.callbacks.isStopping() ? { action: "surface" as const, reason: "disabled" as const } : this.callbacks.decideRecovery(sessionId, error)
		if (this.callbacks.isStopping()) this.callbacks.log("sdkRunErrorRetrySkippedWhileStopping", { source, sessionId })
		if (decision.action === "retry" && await this.attemptRetry(sessionId, source, decision, error)) return
		this.callbacks.log("sdkRunErrorRecoveryConfirmedFailure", { source, sessionId, sessionStatus: sessionStatus || "unknown", recoveryOutcome: decision.action === "retry" ? "retry-failed" : decision.reason, activeTextLength: this.callbacks.activeText().length, hasAssistantText: this.callbacks.hasAssistantText() })
		this.callbacks.projectFailure(source, error)
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
	}

	private async attemptRetry(sessionId: string, source: string, decision: Extract<RuntimeErrorRecoveryDecision, { action: "retry" }>, error: unknown) {
		this.callbacks.log("sdkRunErrorRetryScheduled", { source, sessionId, attempt: decision.attempt, maxAttempts: decision.maxAttempts, error: stringify(error) })
		const retried = await this.callbacks.retry(sessionId, decision).catch((retryError) => {
			this.callbacks.log("sdkRunErrorRetryDispatchFailed", { source, sessionId, attempt: decision.attempt, error: stringify(retryError) })
			return false
		})
		if (!retried) return false
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
		return true
	}
}

function isActiveSessionStatus(status: string) { return ["active", "running", "starting", "streaming", "pending", "in_progress", "in-progress", "awaiting_user"].includes(status) }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
