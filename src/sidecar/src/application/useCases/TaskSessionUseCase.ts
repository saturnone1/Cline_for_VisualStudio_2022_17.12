import type { TaskSessionRuntimePort } from "../ports/TaskSessionRuntimePort"

export type SessionTranscript = {
	session: Record<string, unknown>
	messages: unknown[]
}

export class TaskSessionUseCase {
	constructor(private readonly runtime: TaskSessionRuntimePort) {}

	async activateAndRead(sessionId: string): Promise<SessionTranscript> {
		const session = asRecord(await this.runtime.activateSession(sessionId))
		const messages = asArray(await this.runtime.readMessages({ sessionId }))
		return { session, messages }
	}

	async load(sessionId: string): Promise<SessionTranscript> {
		const session = asRecord(await this.runtime.getSession({ sessionId }))
		const messages = asArray(await this.runtime.readMessages({ sessionId }))
		return { session, messages }
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}
