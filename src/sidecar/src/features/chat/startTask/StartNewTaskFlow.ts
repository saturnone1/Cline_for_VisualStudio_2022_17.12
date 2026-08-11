export type StartNewTaskInput = Readonly<{ text: string; images: string[]; files: string[]; requestedWorkspacePath: string; initialCwd: string; requestId: string; broadcast: boolean }>

type Callbacks = Readonly<{
	isRuntimeAvailable: () => boolean
	stopPrevious: () => Promise<void>
	transitionStarting: () => void
	createTask: (input: StartNewTaskInput) => Record<string, unknown>
	startLatency: (requestId: string, taskId: string, textLength: number) => void
	beginConversation: () => void
	selectTask: (task: Record<string, unknown>) => void
	addUserTask: (text: string, images: string[], files: string[]) => void
	showPreparing: () => void
	noteActivity: (reason: string) => void
	updateTask: () => void
	persist: () => void
	broadcast: () => void
	prepare: (input: StartNewTaskInput, task: Record<string, unknown>) => Promise<void>
	fail: (error: unknown) => Promise<void>
}>

export class StartNewTaskFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute(input: StartNewTaskInput) {
		if (!this.callbacks.isRuntimeAvailable()) throw new Error("LIG VS SDK runtime is not attached.")
		const previousStop = this.callbacks.stopPrevious()
		this.callbacks.transitionStarting()
		const task = this.callbacks.createTask(input)
		this.callbacks.startLatency(input.requestId, String(task.id || ""), input.text.length)
		if (input.requestedWorkspacePath) { task.workspacePath = input.initialCwd; task.worktreePath = input.initialCwd }
		this.callbacks.beginConversation()
		this.callbacks.selectTask(task)
		this.callbacks.addUserTask(input.text, input.images, input.files)
		this.callbacks.showPreparing()
		this.callbacks.noteActivity("start")
		this.callbacks.updateTask()
		this.callbacks.persist()
		if (input.broadcast) this.callbacks.broadcast()
		try {
			await previousStop
		} catch (error) {
			await this.callbacks.fail(error)
			return
		}
		await this.callbacks.prepare(input, task)
	}
}
