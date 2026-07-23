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
	activateTranscript: (taskId: string) => Promise<Transcript>
	getSnapshot: (taskId: string) => { taskItem: TaskHistoryItem; messages: Message[] } | null
	prepareActivation: (taskId: string) => void
	clearLiveInteraction: (reason: string) => void
	projectSession: (session: unknown) => TaskHistoryItem
	projectMessages: (messages: unknown[], task: TaskHistoryItem) => Message[]
	applySelected: (taskId: string, task: TaskHistoryItem, messages: Message[]) => void
	applyShown: (taskId: string, task: TaskHistoryItem, messages: Message[]) => void
	applyHydrated: (taskId: string, task: TaskHistoryItem, messages: Message[]) => void
	reconcileSession: (taskId: string, status: string, source: string) => void
	summarizeMessage: (message: Message) => unknown
	log: (event: string, details: Record<string, unknown>) => void
	broadcast: () => Promise<void>
	isSessionNotFound: (error: unknown) => boolean
}>

export class TaskTranscriptHydrator {
	constructor(private readonly callbacks: Callbacks) {}

	async show(taskId: string) {
		const current = this.callbacks.readCurrentTask()
		if (String(current?.id || "") === taskId && this.callbacks.readMessages().length > 0) {
			this.callbacks.log("showTaskWithId.currentStateFallback", { sessionId: taskId })
			await this.callbacks.broadcast()
			return
		}
		const snapshot = this.callbacks.getSnapshot(taskId)
		if (snapshot) {
			this.callbacks.clearLiveInteraction("showTaskWithId:snapshot")
			this.callbacks.applyShown(taskId, { ...snapshot.taskItem }, snapshot.messages.map((message) => ({ ...message })))
			await this.callbacks.broadcast()
			return
		}
		if (!this.callbacks.isAvailable() || !taskId) return
		this.callbacks.clearLiveInteraction("showTaskWithId")
		this.callbacks.prepareActivation(taskId)
		try {
			const transcript = await this.callbacks.activateTranscript(taskId)
			const projected = this.project(transcript, false, false)
			if (!projected) return
			this.callbacks.log("sdkMessagesHydrated", { source: "showTaskWithId", sessionId: taskId, sdkCount: projected.sdkCount, clineCount: projected.messages.length, messages: projected.messages.map(this.callbacks.summarizeMessage) })
			this.callbacks.applyShown(taskId, projected.task, projected.messages)
			await this.callbacks.broadcast()
		} catch (error) {
			if (!this.callbacks.isSessionNotFound(error)) throw error
			this.callbacks.log("showTaskWithId.sdkMissingFallback", { sessionId: taskId, error: stringify(error) })
		}
	}

	async refreshSelected() {
		const current = this.callbacks.readCurrentTask()
		if (!this.callbacks.isAvailable() || !current) return
		const taskId = String(current.id || "")
		if (!taskId) return
		const activeSessionId = this.callbacks.activeSessionId()
		if (activeSessionId && activeSessionId !== taskId) return
		const currentMessages = this.callbacks.readMessages()

		const projected = await this.load(taskId, false)
		if (!projected) return
		this.callbacks.reconcileSession(taskId, projected.sessionStatus, "refreshSelectedTaskFromSdk")
		const reconciled = reconcileTranscriptMessages(currentMessages, projected.messages)
		if (!reconciled.changed) return this.logSkip("already_current", taskId, activeSessionId)
		this.callbacks.log("sdkMessagesHydrated", { source: "refreshSelectedTaskFromSdk", sessionId: taskId, sdkCount: projected.sdkCount, clineCount: reconciled.messages.length, liveProjection: this.callbacks.hasLiveProjection(), messages: projected.messages.map(this.callbacks.summarizeMessage) })
		this.callbacks.applySelected(taskId, projected.task, reconciled.messages)
		return true
	}

	async hydrateCurrent(sessionId: string, source: string, force = false) {
		const current = this.callbacks.readCurrentTask()
		if (!this.callbacks.isAvailable() || !current || !sessionId) return false
		const currentTaskId = String(current.id || "")
		if (currentTaskId && currentTaskId !== sessionId) return false
		if (!force && this.callbacks.hasLiveProjection()) return false
		const projected = await this.load(sessionId, true)
		if (!projected || !projected.messages.length) return false
		this.callbacks.reconcileSession(sessionId, projected.sessionStatus, source)
		const reconciled = reconcileTranscriptMessages(this.callbacks.readMessages(), projected.messages)
		if (!reconciled.changed) return false
		this.callbacks.applyHydrated(sessionId, projected.task, reconciled.messages)
		this.callbacks.log("sdkMessagesHydrated", { source, sessionId, sdkCount: projected.sdkCount, clineCount: reconciled.messages.length, force })
		return true
	}

	private async load(taskId: string, requireMessages: boolean) {
		const transcript = await this.callbacks.loadTranscript(taskId).catch(() => null)
		return transcript ? this.project(transcript, requireMessages) : null
	}

	private project(transcript: Transcript, requireMessages: boolean, requireSession = true) {
		const session = asRecord(transcript?.session)
		if (requireSession && !Object.keys(session).length) return null
		const sdkMessages = transcript?.messages
		if (!Array.isArray(sdkMessages) || (requireMessages && !sdkMessages.length)) return null
		const task = this.callbacks.projectSession(session)
		const bootstrapCount = internalBootstrapMessageCount(session, sdkMessages)
		const visibleMessages = bootstrapCount > 0 ? sdkMessages.slice(bootstrapCount) : sdkMessages
		return { task, messages: this.callbacks.projectMessages(visibleMessages, task), sdkCount: sdkMessages.length, sessionStatus: stringValue(session.status) }
	}

	private logSkip(reason: string, taskId: string, activeSessionId: string) {
		this.callbacks.log("stateHydration.selectedTaskSkipped", { reason, taskId, activeSessionId })
	}
}

export function reconcileTranscriptMessages(current: readonly Message[], projected: readonly Message[]) {
	const next = current.map((message) => ({ ...message }))
	const currentSignatureCounts = countSignatures(next)
	const projectedSignatureCounts = new Map<string, number>()
	let changed = false
	for (const candidate of projected) {
		const signature = messageSignature(candidate)
		if (!signature) continue
		const occurrence = (projectedSignatureCounts.get(signature) || 0) + 1
		projectedSignatureCounts.set(signature, occurrence)
		if ((currentSignatureCounts.get(signature) || 0) >= occurrence) continue
		if (candidate.partial !== true && isAssistantText(candidate)) {
			const partialIndex = findLastIndex(next, (message) => message.partial === true && isAssistantText(message) && textsOverlap(message, candidate))
			if (partialIndex >= 0) next.splice(partialIndex, 1)
		}
		next.push({ ...candidate, partial: candidate.partial === true ? true : undefined })
		changed = true
	}
	return { changed, messages: next }
}

function messageSignature(message: Message) {
	const type = stringValue(message.type), kind = stringValue(message.say) || stringValue(message.ask)
	const text = normalizeText(stringValue(message.text))
	if (!type || !kind || !text || kind === "api_req_started" || kind === "reasoning" || kind === "completion_result") return ""
	return `${type}:${semanticMessageKind(type, kind)}:${text}`
}

function semanticMessageKind(type: string, kind: string) {
	if (type === "say" && (kind === "task" || kind === "user_feedback")) return "user"
	if (type === "say" && kind === "text") return "assistant"
	return kind
}

function countSignatures(messages: readonly Message[]) {
	const counts = new Map<string, number>()
	for (const message of messages) {
		const signature = messageSignature(message)
		if (signature) counts.set(signature, (counts.get(signature) || 0) + 1)
	}
	return counts
}

function isAssistantText(message: Message) { return message.type === "say" && message.say === "text" && Boolean(stringValue(message.text).trim()) }
function textsOverlap(left: Message, right: Message) { const partial = normalizeText(stringValue(left.text)), completed = normalizeText(stringValue(right.text)); return Boolean(partial && completed && completed.startsWith(partial)) }
function normalizeText(value: string) { return value.replace(/\s+/g, " ").trim() }
function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean) { for (let index = values.length - 1; index >= 0; index--) if (predicate(values[index])) return index; return -1 }

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
function internalBootstrapMessageCount(session: Record<string, unknown>, messages: unknown[]) {
	const metadata = asRecord(session.metadata ?? session.sessionMetadata)
	const compactedCount = metadata.ligVsCompactedInitialMessageCount
	if (metadata.ligVsContextCompaction === true && typeof compactedCount === "number" && Number.isInteger(compactedCount) && compactedCount > 0) return compactedCount
	if (metadata.ligVsResumed !== true) return 0
	const prompt = normalizeText(stringValue(session.prompt))
	if (!prompt) return 0
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = asRecord(messages[index])
		if (stringValue(message.role) !== "user") continue
		const rawText = sdkMessageText(message.content)
		const wrappedPrompt = extractUserInput(rawText)
		const text = normalizeText(rawText)
		if ((wrappedPrompt && normalizeText(wrappedPrompt) === prompt) || text === prompt) return index
	}
	return 0
}

function extractUserInput(value: string) { return /<user_input\b[^>]*>([\s\S]*?)<\/user_input>/i.exec(value)?.[1] || "" }

function sdkMessageText(value: unknown): string {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return ""
	return value.map((part) => {
		if (typeof part === "string") return part
		const record = asRecord(part)
		return stringValue(record.text) || stringValue(record.content)
	}).filter(Boolean).join("\n")
}
