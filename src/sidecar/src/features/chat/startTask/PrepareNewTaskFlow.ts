type Input = Readonly<{ text: string; images: string[]; files: string[]; requestedWorkspacePath: string; initialCwd: string; taskItem: Record<string, unknown> }>
type Callbacks = Readonly<{
	isRuntimeAvailable: () => boolean
	workspaceRoots: () => Promise<string[]>
	resolveWorkspacePath: (requestedPath: string) => string | null
	updateTask: () => void
	publishPreparing: () => void
	activeSessionId: () => string
	markClosing: (sessionId: string, closing?: boolean) => void
	stopSession: (sessionId: string) => Promise<unknown>
	runHook: (name: "TaskStart" | "UserPromptSubmit", context: Record<string, unknown>) => void
	normalizeImages: (images: string[]) => Promise<readonly string[]>
	launch: (params: Readonly<{ prompt: string; cwd: string; userImages: readonly string[]; userFiles: readonly string[]; interactive: true }>, cwd: string, sessionId: string) => Promise<void>
	projectError: (error: unknown) => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class PrepareNewTaskFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async stopPrevious() {
		const previousSessionId = this.callbacks.activeSessionId()
		if (!previousSessionId) return
		this.callbacks.markClosing(previousSessionId)
		try {
			await this.callbacks.stopSession(previousSessionId)
		} catch (error) {
			this.callbacks.markClosing(previousSessionId, false)
			this.callbacks.log("startNewTask.stopPreviousFailed", { sessionId: previousSessionId, error: stringify(error) })
			throw error
		}
	}

	async execute(input: Input) {
		if (!this.callbacks.isRuntimeAvailable()) return
		let cwd = input.initialCwd
		try {
			const roots = await this.callbacks.workspaceRoots()
			cwd = this.callbacks.resolveWorkspacePath(input.requestedWorkspacePath) || roots[0] || input.initialCwd
			input.taskItem.cwdOnTaskInitialization = cwd
			if (input.requestedWorkspacePath) { input.taskItem.workspacePath = cwd; input.taskItem.worktreePath = cwd }
			this.callbacks.updateTask()
			this.callbacks.publishPreparing()
			const sessionId = String(input.taskItem.id || ""), context = { prompt: input.text, cwd, files: input.files, images: input.images, sessionId }
			this.callbacks.runHook("TaskStart", context)
			this.callbacks.runHook("UserPromptSubmit", context)
			const userImages = await this.callbacks.normalizeImages(input.images)
			void this.callbacks.launch({ prompt: input.text, cwd, userImages, userFiles: input.files, interactive: true }, cwd, sessionId)
		} catch (error) {
			await this.callbacks.projectError(error)
		}
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
