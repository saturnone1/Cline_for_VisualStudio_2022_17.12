export type TaskPromptRequest = Readonly<{
	text: string
	answerText: string
	responseType: string
	images: string[]
	files: string[]
	workspacePath: string
	delivery: string
	clientOperationId: string
}>

export type TaskCommand =
	| Readonly<{ type: "clear" }>
	| Readonly<{ type: "newTask"; request: TaskPromptRequest }>
	| Readonly<{ type: "askResponse"; request: TaskPromptRequest }>
	| Readonly<{ type: "compact" }>
	| Readonly<{ type: "cancel" }>
	| Readonly<{ type: "history"; query: TaskHistoryQuery }>
	| Readonly<{ type: "historySize" }>
	| Readonly<{ type: "show"; taskId: string }>
	| Readonly<{ type: "delete"; taskIds: string[] }>
	| Readonly<{ type: "deleteAll" }>
	| Readonly<{ type: "toggleFavorite"; taskId: string; isFavorited: boolean }>

export type TaskRpcResult = Readonly<{ payload: Record<string, unknown>; includeStateMessages?: boolean }>

type Callbacks = Readonly<{
	hasPendingQuestion: () => boolean
	hasCurrentTask: () => boolean
	isStarting?: () => boolean
	start: (request: TaskPromptRequest, requestId: string) => Promise<void>
	respond: (request: TaskPromptRequest, requestId: string) => Promise<void>
	compact: (requestId: string, signal?: AbortSignal) => Promise<void>
	cancel: () => Promise<void>
	clear: () => Promise<void>
	refreshHistory: (source: string) => Promise<void>
	history: () => readonly Record<string, unknown>[]
	currentWorkspace: () => Promise<string>
	show: (taskId: string) => Promise<void>
	delete: (taskIds: readonly string[]) => Promise<void>
	deleteAll: () => Promise<void>
	toggleFavorite: (taskId: string, isFavorited: boolean) => Promise<void>
	broadcast: () => Promise<void>
	operationHistoryLimit: () => number
}>

export class TaskRpcHandler {
	private readonly acceptedOperations = new Set<string>()
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: TaskCommand, requestId: string, signal?: AbortSignal): Promise<TaskRpcResult> {
		switch (command.type) {
			case "clear": await this.callbacks.clear(); return empty()
			case "newTask":
				if (this.callbacks.isStarting?.()) return { payload: {}, includeStateMessages: true }
				return this.once(command.request.clientOperationId || requestId, async () => {
					if (this.callbacks.hasPendingQuestion() || (this.callbacks.hasCurrentTask() && command.request.text.trim())) {
						await this.callbacks.respond(command.request, requestId)
						return { payload: {}, includeStateMessages: true }
					}
					await this.callbacks.start(command.request, requestId)
					return empty()
				})
			case "askResponse": return this.once(command.request.clientOperationId || requestId, async () => { await this.callbacks.respond(command.request, requestId); return empty() })
			case "compact": await this.callbacks.compact(requestId, signal); return { payload: {}, includeStateMessages: true }
			case "cancel": await this.callbacks.cancel(); return empty()
			case "history": {
				await this.callbacks.refreshHistory("getTaskHistory")
				const matches = queryTaskHistory(this.callbacks.history(), command.query, await this.callbacks.currentWorkspace())
				const cursor = Math.min(matches.length, Math.max(0, command.query.cursor ?? 0))
				const pageSize = Math.min(500, Math.max(1, command.query.pageSize ?? 100))
				const next = Math.min(matches.length, cursor + pageSize)
				return { payload: { tasks: matches.slice(cursor, next), nextCursor: next < matches.length ? next : -1, total: matches.length } }
			}
			case "historySize": await this.callbacks.refreshHistory("getTotalTasksSize"); return { payload: { value: taskHistorySize(this.callbacks.history()) } }
			case "show": await this.callbacks.show(command.taskId); return empty()
			case "delete": await this.callbacks.delete(command.taskIds); await this.callbacks.broadcast(); return empty()
			case "deleteAll": await this.callbacks.deleteAll(); await this.callbacks.broadcast(); return empty()
			case "toggleFavorite": await this.callbacks.toggleFavorite(command.taskId, command.isFavorited); await this.callbacks.broadcast(); return empty()
		}
	}

	private async once(operationId: string, action: () => Promise<TaskRpcResult>) {
		if (this.acceptedOperations.has(operationId)) return { payload: {}, includeStateMessages: true }
		this.acceptedOperations.add(operationId)
		this.trimOperationHistory()
		try { return await action() } catch (error) { this.acceptedOperations.delete(operationId); throw error }
	}

	private trimOperationHistory() {
		const limit = Math.max(32, this.callbacks.operationHistoryLimit())
		while (this.acceptedOperations.size > limit) {
			const oldest = this.acceptedOperations.values().next().value as string | undefined
			if (!oldest) break
			this.acceptedOperations.delete(oldest)
		}
	}
}

function empty(): TaskRpcResult { return { payload: {} } }
import { queryTaskHistory, taskHistorySize, type TaskHistoryQuery } from "../taskHistory/TaskHistoryQuery"
