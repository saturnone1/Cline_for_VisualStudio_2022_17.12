import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"
import type { SendMessageCommand } from "../sendMessage/SendMessageCommand"
import { RESUMED_SESSION_FORMAT_VERSION } from "./ResumeSessionFlow"

type Callbacks = Readonly<{
	activeSettingsRevision: () => number
	settingsRevision: () => number
	activeConnectionRevision: () => number
	connectionRevision: () => number
	syncConnection: (sessionId: string) => Promise<void>
	markConnectionRevisionActive: () => void
	requiresReplacement: (sessionId: string) => boolean
	bindSession: (sessionId: string) => void
	markClosing: (sessionId: string, closing: boolean) => void
	send: (command: SendMessageCommand) => Promise<unknown>
	resume: (sessionId: string, command: SendMessageCommand, textLength: number) => Promise<unknown>
	markSend: (sessionId: string) => void
	markError: (sessionId: string, error: unknown) => void
	isSessionNotFound: (error: unknown) => boolean
	log: (event: string, details: Record<string, unknown>) => void
}>

export class SendOrResumeSessionFlow {
	private readonly validatedSessions = new Set<string>()
	private readonly maxValidatedSessions = 256
	constructor(private readonly engine: () => AgentEnginePort | null, private readonly callbacks: Callbacks) {}

	async execute(sessionId: string, command: SendMessageCommand, textLength: number) {
		const engine = this.engine()
		if (!engine) throw new Error("LIG VS SDK runtime is not attached.")
		if (this.callbacks.requiresReplacement(sessionId)) {
			this.callbacks.log("sendAskResponse.replaceQuarantinedSession", { sessionId })
			return this.callbacks.resume(sessionId, command, textLength)
		}
		let activateMissing = false
		let activatedSession: unknown
		if (engine.status.activeSessionId !== sessionId) {
			this.callbacks.log("sendAskResponse.activateSession", { from: engine.status.activeSessionId, to: sessionId })
			activatedSession = await engine.activateSession(sessionId).catch((error) => {
				if (!this.callbacks.isSessionNotFound(error)) throw error
				activateMissing = true
				this.callbacks.log("sendAskResponse.activateSessionMissing", { sessionId, error: stringify(error) })
				return null
			})
			if (!activatedSession) activateMissing = true
		}
		try {
			if (activateMissing) return await this.callbacks.resume(sessionId, command, textLength)
			if (!this.validatedSessions.has(sessionId)) {
				const session = activatedSession || await engine.getSession({ sessionId }).catch((error) => {
					this.callbacks.log("sendAskResponse.sessionFormatInspectionFailed", { sessionId, error: stringify(error) })
					return null
				})
				if (session) this.rememberValidatedSession(sessionId)
				if (session && requiresResumeMigration(session)) {
					this.callbacks.log("sendAskResponse.replaceLegacyResumedSession", { sessionId })
					this.callbacks.markClosing(sessionId, true)
					await engine.stop({ sessionId }).catch((error) => this.callbacks.log("sendAskResponse.stopLegacyResumeFailed", { sessionId, error: stringify(error) }))
					this.callbacks.markClosing(sessionId, false)
					return await this.callbacks.resume(sessionId, command, textLength)
				}
			}
			this.callbacks.bindSession(sessionId)
			const activeRevision = this.callbacks.activeSettingsRevision(), revision = this.callbacks.settingsRevision()
			if (activeRevision !== revision) {
				this.callbacks.log("sendAskResponse.restartForSettingsChange", { sessionId, activeSessionRuntimeSettingsRevision: activeRevision, runtimeSettingsRevision: revision })
				this.callbacks.markClosing(sessionId, true)
				await engine.stop({ sessionId }).catch((error) => this.callbacks.log("sendAskResponse.stopForSettingsChangeFailed", { sessionId, error: stringify(error) }))
				this.callbacks.markClosing(sessionId, false)
				return await this.callbacks.resume(sessionId, command, textLength)
			}
			const activeConnectionRevision = this.callbacks.activeConnectionRevision()
			const connectionRevision = this.callbacks.connectionRevision()
			if (activeConnectionRevision !== connectionRevision) {
				this.callbacks.log("sendAskResponse.updateConnectionForSettingsChange", { sessionId, activeConnectionRevision, connectionRevision })
				await this.callbacks.syncConnection(sessionId)
				this.callbacks.markConnectionRevisionActive()
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

	private rememberValidatedSession(sessionId: string) {
		this.validatedSessions.add(sessionId)
		while (this.validatedSessions.size > this.maxValidatedSessions) {
			const oldest = this.validatedSessions.values().next().value as string | undefined
			if (!oldest) break
			this.validatedSessions.delete(oldest)
		}
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
function requiresResumeMigration(value: unknown) {
	const session = asRecord(asRecord(value).session ?? value)
	const metadata = asRecord(session.metadata ?? session.sessionMetadata)
	return metadata.ligVsResumed === true && metadata.ligVsResumeFormatVersion !== RESUMED_SESSION_FORMAT_VERSION
}
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
