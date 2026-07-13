import type { AgentMessageRequest, AgentSessionRequest, AgentStartRequest } from "../../application/ports/AgentEnginePort"
import { buildSdkStartInput, normalizeAgentMode } from "./SdkSessionRequestBuilder"

type ClineSdkModule = typeof import("@cline/sdk")
export type ClineSdkCore = Awaited<ReturnType<ClineSdkModule["ClineCore"]["create"]>>

type SessionAdapterDependencies = {
	getCore: () => Promise<ClineSdkCore>
	getCurrentCore: () => ClineSdkCore | null
	getActiveSessionId: () => string | null
	setActiveSessionId: (sessionId: string | null) => void
	getWorkspacePaths: () => Promise<string[]>
	createExtraTools: () => Promise<unknown>
	getStatus: () => unknown
}

export class ClineSdkSessionAdapter {
	constructor(private readonly dependencies: SessionAdapterDependencies) {}

	markInactive(sessionId?: string) {
		if (!sessionId || this.dependencies.getActiveSessionId() === sessionId) {
			this.dependencies.setActiveSessionId(null)
		}
	}

	async activate(sessionId: string) {
		const core = await this.dependencies.getCore()
		if (!sessionId) {
			this.dependencies.setActiveSessionId(null)
			return null
		}

		const session = await core.get(sessionId)
		if (session) this.dependencies.setActiveSessionId(sessionId)
		return session
	}

	async start(request: AgentStartRequest) {
		const core = await this.dependencies.getCore()
		const workspaceRoots = await this.dependencies.getWorkspacePaths()
		const { startInput, requestedSessionId } = buildSdkStartInput(request, workspaceRoots, await this.dependencies.createExtraTools())

		if (requestedSessionId) this.dependencies.setActiveSessionId(requestedSessionId)
		try {
			const result = await core.start(startInput)
			this.dependencies.setActiveSessionId(result.sessionId || requestedSessionId || this.dependencies.getActiveSessionId())
			return result
		} catch (error) {
			if (requestedSessionId && this.dependencies.getActiveSessionId() === requestedSessionId) {
				this.dependencies.setActiveSessionId(null)
			}
			throw error
		}
	}

	async send(request: AgentMessageRequest) {
		const core = await this.dependencies.getCore()
		const sessionId = request.sessionId || this.dependencies.getActiveSessionId()
		if (!sessionId) throw new Error("No active Cline SDK session. Call sdk.startSession first.")

		try {
			return await core.send({
				sessionId,
				prompt: request.prompt,
				mode: normalizeAgentMode(request.mode),
				delivery: request.delivery === "queue" || request.delivery === "steer" ? request.delivery : undefined,
				userImages: [...(request.userImages || [])],
				userFiles: [...(request.userFiles || [])],
			})
		} catch (error) {
			if (this.dependencies.getActiveSessionId() === sessionId && /session not found/i.test(error instanceof Error ? error.message : String(error))) {
				this.dependencies.setActiveSessionId(null)
			}
			throw error
		}
	}

	async stop(request: AgentSessionRequest) {
		const sessionId = stringValue(request.sessionId) || this.dependencies.getActiveSessionId()
		const core = this.dependencies.getCurrentCore()
		if (!sessionId || !core) return this.dependencies.getStatus()

		await core.stop(sessionId)
		if (this.dependencies.getActiveSessionId() === sessionId) this.dependencies.setActiveSessionId(null)
		return this.dependencies.getStatus()
	}

	async abort(request: AgentSessionRequest) {
		const core = await this.dependencies.getCore()
		const sessionId = stringValue(request.sessionId) || this.dependencies.getActiveSessionId()
		if (!sessionId) return this.dependencies.getStatus()

		await core.abort(sessionId)
		this.dependencies.setActiveSessionId(sessionId)
		return this.dependencies.getStatus()
	}

	async listHistory(params: unknown) {
		return (await this.dependencies.getCore()).listHistory({ limit: numberValue(asRecord(params).limit) || 50 })
	}

	async getSession(params: unknown) {
		const sessionId = stringValue(asRecord(params).sessionId) || this.dependencies.getActiveSessionId()
		return sessionId ? (await this.dependencies.getCore()).get(sessionId) : null
	}

	async readMessages(params: unknown) {
		const sessionId = stringValue(asRecord(params).sessionId) || this.dependencies.getActiveSessionId()
		return sessionId ? (await this.dependencies.getCore()).readMessages(sessionId) : []
	}

	async deleteSession(params: unknown) {
		const sessionId = stringValue(asRecord(params).sessionId)
		if (!sessionId) return false
		if (this.dependencies.getActiveSessionId() === sessionId) this.dependencies.setActiveSessionId(null)
		return (await this.dependencies.getCore()).delete(sessionId)
	}

	async updateSession(params: unknown) {
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.dependencies.getActiveSessionId()
		if (!sessionId) throw new Error("No Cline SDK session selected.")
		return (await this.dependencies.getCore()).update(sessionId, {
			title: stringValue(request.title) || null,
			prompt: stringValue(request.prompt) || null,
			metadata: asRecord(request.metadata),
		})
	}

	async getUsage(params: unknown) {
		const sessionId = stringValue(asRecord(params).sessionId) || this.dependencies.getActiveSessionId()
		return sessionId ? (await this.dependencies.getCore()).getAccumulatedUsage(sessionId) : null
	}

	async restore(params: unknown) {
		const request = asRecord(params)
		const sessionId = stringValue(request.sessionId) || this.dependencies.getActiveSessionId()
		const checkpointRunCount = numberValue(request.checkpointRunCount)
		if (!sessionId || checkpointRunCount === undefined) {
			throw new Error("SDK restore requires sessionId and checkpointRunCount.")
		}

		const result = await (await this.dependencies.getCore()).restore({
			sessionId,
			checkpointRunCount,
			cwd: stringValue(request.cwd),
			restore: asRecord(request.restore),
			start: request.start as any,
		})
		this.dependencies.setActiveSessionId(result.sessionId || result.startResult?.sessionId || this.dependencies.getActiveSessionId())
		return result
	}

	async listSettings(params: unknown) {
		return (await this.dependencies.getCore()).settings.list(asRecord(params))
	}

	async toggleSetting(params: unknown) {
		return (await this.dependencies.getCore()).settings.toggle(asRecord(params) as any)
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function numberValue(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
