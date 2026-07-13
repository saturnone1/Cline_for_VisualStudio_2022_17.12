export type TaskPromptRequest = Readonly<{
	text: string
	answerText: string
	responseType: string
	images: string[]
	files: string[]
	workspacePath: string
	delivery: string
}>

export type TaskCommand =
	| Readonly<{ type: "clear" }>
	| Readonly<{ type: "newTask"; request: TaskPromptRequest }>
	| Readonly<{ type: "askResponse"; request: TaskPromptRequest }>
	| Readonly<{ type: "compact" }>
	| Readonly<{ type: "cancel" }>
	| Readonly<{ type: "history" }>
	| Readonly<{ type: "historySize" }>
	| Readonly<{ type: "show"; taskId: string }>
	| Readonly<{ type: "delete"; taskIds: string[] }>
	| Readonly<{ type: "deleteAll" }>
	| Readonly<{ type: "toggleFavorite"; taskId: string; isFavorited: boolean }>

export type TaskRpcResult = Readonly<{ payload: Record<string, unknown>; includeStateMessages?: boolean }>

type Callbacks = Readonly<{
	hasPendingQuestion: () => boolean
	hasCurrentTask: () => boolean
	start: (request: TaskPromptRequest, requestId: string) => Promise<void>
	respond: (request: TaskPromptRequest, requestId: string) => Promise<void>
	compact: (requestId: string) => Promise<void>
	cancel: () => Promise<void>
	clear: () => Promise<void>
	refreshHistory: (source: string) => Promise<void>
	history: () => readonly Record<string, unknown>[]
	show: (taskId: string) => Promise<void>
	delete: (taskIds: readonly string[]) => Promise<void>
	deleteAll: () => Promise<void>
	toggleFavorite: (taskId: string, isFavorited: boolean) => void
	broadcast: () => Promise<void>
}>

export class TaskRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: TaskCommand, requestId: string): Promise<TaskRpcResult> {
		switch (command.type) {
			case "clear": await this.callbacks.clear(); return empty()
			case "newTask":
				if (this.callbacks.hasPendingQuestion() || (this.callbacks.hasCurrentTask() && command.request.text.trim())) {
					await this.callbacks.respond(command.request, requestId)
					return { payload: {}, includeStateMessages: true }
				}
				await this.callbacks.start(command.request, requestId)
				return empty()
			case "askResponse": await this.callbacks.respond(command.request, requestId); return empty()
			case "compact": await this.callbacks.compact(requestId); return { payload: {}, includeStateMessages: true }
			case "cancel": await this.callbacks.cancel(); return empty()
			case "history": await this.callbacks.refreshHistory("getTaskHistory"); return { payload: { tasks: this.callbacks.history() } }
			case "historySize": await this.callbacks.refreshHistory("getTotalTasksSize"); return { payload: { value: this.callbacks.history().length } }
			case "show": await this.callbacks.show(command.taskId); return empty()
			case "delete": await this.callbacks.delete(command.taskIds); await this.callbacks.broadcast(); return empty()
			case "deleteAll": await this.callbacks.deleteAll(); await this.callbacks.broadcast(); return empty()
			case "toggleFavorite": this.callbacks.toggleFavorite(command.taskId, command.isFavorited); await this.callbacks.broadcast(); return empty()
		}
	}
}

function empty(): TaskRpcResult { return { payload: {} } }
