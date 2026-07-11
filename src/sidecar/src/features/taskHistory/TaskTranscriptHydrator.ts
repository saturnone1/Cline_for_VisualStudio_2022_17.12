import type { TaskHistoryItem } from "./TaskHistoryCollection"

type Message = Record<string, unknown>
type Transcript = { session: unknown; messages: unknown }
type Callbacks = Readonly<{
	isAvailable: () => boolean
	readCurrentTask: () => TaskHistoryItem | null
	activeSessionId: () => string
	hasLiveProjection: () => boolean
	readMessages: () => readonly Message[]
	loadTranscript: (taskId: string) => Promise<Transcript | null>
	projectSession: (session: unknown) => TaskHistoryItem
	projectMessages: (messages: unknown[], task: TaskHistoryItem) => Message[]
	applySelected: (taskId: string, task: TaskHistoryItem, messages: Message[]) => void
	applyCompleted: (taskId: string, task: TaskHistoryItem, messages: Message[]) => void
	summarizeMessage: (message: Message) => unknown
	log: (event: string, details: Record<string, unknown>) => void
}>

export class TaskTranscriptHydrator {
	constructor(private readonly callbacks: Callbacks) {}

	async refreshSelected() {
		const current = this.callbacks.readCurrentTask()
		if (!this.callbacks.isAvailable() || !current) return
		const taskId = String(current.id || "")
		if (!taskId) return
		const activeSessionId = this.callbacks.activeSessionId()
		if (activeSessionId && activeSessionId !== taskId) return
		if (this.callbacks.hasLiveProjection()) return this.logSkip("live_interaction", taskId, activeSessionId)
		const currentMessages = this.callbacks.readMessages()
		if (activeSessionId === taskId && currentMessages.some((message) => message.partial === true)) return this.logSkip("partial_messages", taskId, activeSessionId)
		if (activeSessionId === taskId && currentMessages.length > 0) return

		const projected = await this.load(taskId, false)
		if (!projected) return
		this.callbacks.log("sdkMessagesHydrated", { source: "refreshSelectedTaskFromSdk", sessionId: taskId, sdkCount: projected.sdkCount, clineCount: projected.messages.length, messages: projected.messages.map(this.callbacks.summarizeMessage) })
		this.callbacks.applySelected(taskId, projected.task, projected.messages)
	}

	async hydrateCurrent(sessionId: string, source: string, force = false) {
		const current = this.callbacks.readCurrentTask()
		if (!this.callbacks.isAvailable() || !current || !sessionId) return false
		const currentTaskId = String(current.id || "")
		if (currentTaskId && currentTaskId !== sessionId) return false
		if (!force && this.callbacks.hasLiveProjection()) return false
		const projected = await this.load(sessionId, true)
		if (!projected || !projected.messages.length) return false
		this.callbacks.applyCompleted(sessionId, projected.task, projected.messages)
		this.callbacks.log("sdkMessagesHydrated", { source, sessionId, sdkCount: projected.sdkCount, clineCount: this.callbacks.readMessages().length, force })
		return true
	}

	private async load(taskId: string, requireMessages: boolean) {
		const transcript = await this.callbacks.loadTranscript(taskId).catch(() => null)
		const session = asRecord(transcript?.session)
		if (!Object.keys(session).length) return null
		const sdkMessages = transcript?.messages
		if (!Array.isArray(sdkMessages) || (requireMessages && !sdkMessages.length)) return null
		const task = this.callbacks.projectSession(session)
		return { task, messages: this.callbacks.projectMessages(sdkMessages, task), sdkCount: sdkMessages.length }
	}

	private logSkip(reason: string, taskId: string, activeSessionId: string) {
		this.callbacks.log("stateHydration.selectedTaskSkipped", { reason, taskId, activeSessionId })
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
