export type SessionIdRequest = Readonly<{ sessionId: string }>

export interface TaskSessionRuntimePort {
	activateSession(sessionId: string): Promise<unknown>
	getSession(request: SessionIdRequest): Promise<unknown>
	readMessages(request: SessionIdRequest): Promise<unknown>
}
