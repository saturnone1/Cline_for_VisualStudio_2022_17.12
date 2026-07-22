import type { SessionSnapshotRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import { normalizeUsageSnapshot } from "./UsageNormalization"

type Usage = Readonly<{ modelId?: string; tokensIn?: number; tokensOut?: number; cacheReads?: number; cacheWrites?: number; totalCost?: number }>
type Callbacks = Readonly<{
	bindSession: (sessionId: string) => void
	finishTask: (sessionId: string, status: string, text: string) => void
	noteActivity: (reason: string) => void
	activeText: () => string
	updateTask: (updates: Usage) => void
	broadcast: () => void
}>

export class AgentSnapshotEventProjector {
	constructor(private readonly callbacks: Callbacks) {}

	handle(event: SessionSnapshotRuntimeEvent) {
		if (event.sessionId) this.callbacks.bindSession(event.sessionId)
		const usage = normalizeUsageSnapshot(event.usage)
		this.callbacks.noteActivity(`session_snapshot:${event.status || "unknown"}`)
		this.callbacks.updateTask({ modelId: event.modelId || undefined, tokensIn: usage.reliable ? usage.inputTokens : undefined, tokensOut: usage.reliable ? usage.outputTokens : undefined, cacheReads: usage.reliable ? usage.cacheReadTokens : undefined, cacheWrites: usage.reliable ? usage.cacheWriteTokens : undefined, totalCost: usage.reliable ? usage.totalCost : undefined })
		if (event.status && !ACTIVE_STATUSES.has(event.status)) this.callbacks.finishTask(event.sessionId, event.status, this.callbacks.activeText())
		this.callbacks.broadcast()
	}
}

const ACTIVE_STATUSES = new Set(["running", "pending", "starting", "idle"])
