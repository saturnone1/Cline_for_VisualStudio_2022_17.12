import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"
import type { SendMessageCommand } from "../sendMessage/SendMessageCommand"

type Callbacks = Readonly<{
	activeSettingsRevision: () => number
	settingsRevision: () => number
	markClosing: (sessionId: string, closing: boolean) => void
	send: (command: SendMessageCommand) => Promise<unknown>
	resume: (sessionId: string, command: SendMessageCommand, textLength: number) => Promise<unknown>
	markSend: (sessionId: string) => void
	markError: (sessionId: string, error: unknown) => void
	isSessionNotFound: (error: unknown) => boolean
	log: (event: string, details: Record<string, unknown>) => void
}>

export class SendOrResumeSessionFlow {
	constructor(private readonly engine: () => AgentEnginePort | null, private readonly callbacks: Callbacks) {}

	async execute(sessionId: string, command: SendMessageCommand, textLength: number) {
		const engine = this.engine()
		if (!engine) throw new Error("LIG VS SDK runtime is not attached.")
		let activateMissing = false
		if (engine.status.activeSessionId !== sessionId) {
			this.callbacks.log("sendAskResponse.activateSession", { from: engine.status.activeSessionId, to: sessionId })
			const activated = await engine.activateSession(sessionId).catch((error) => {
				if (!this.callbacks.isSessionNotFound(error)) throw error
				activateMissing = true
				this.callbacks.log("sendAskResponse.activateSessionMissing", { sessionId, error: stringify(error) })
				return null
			})
			if (!activated) activateMissing = true
		}
		try {
			if (activateMissing) return await this.callbacks.resume(sessionId, command, textLength)
			const activeRevision = this.callbacks.activeSettingsRevision(), revision = this.callbacks.settingsRevision()
			if (activeRevision !== revision) {
				this.callbacks.log("sendAskResponse.restartForSettingsChange", { sessionId, activeSessionRuntimeSettingsRevision: activeRevision, runtimeSettingsRevision: revision })
				this.callbacks.markClosing(sessionId, true)
				await engine.stop({ sessionId }).catch((error) => this.callbacks.log("sendAskResponse.stopForSettingsChangeFailed", { sessionId, error: stringify(error) }))
				this.callbacks.markClosing(sessionId, false)
				return await this.callbacks.resume(sessionId, command, textLength)
			}
			this.callbacks.markSend(sessionId)
			this.callbacks.log("sendAskResponse.sdkSend", { sessionId, textLength })
			return await this.callbacks.send(command)
		} catch (error) {
			if (!this.callbacks.isSessionNotFound(error)) {
				this.callbacks.markError(sessionId, error)
				throw error
			}
			this.callbacks.log("sendAskResponse.sdkSendMissingSession", { sessionId, error: stringify(error) })
			try {
				return await this.callbacks.resume(sessionId, command, textLength)
			} catch (resumeError) {
				this.callbacks.markError(sessionId, resumeError)
				throw resumeError
			}
		}
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
