import type { TaskPromptRequest } from "./TaskRpcHandler"
import type { AskResponseInteractionFlow } from "./sendMessage/AskResponseInteractionFlow"
import type { SendUserMessageFlow } from "./sendMessage/SendUserMessageFlow"
import type { StartNewTaskFlow } from "./startTask/StartNewTaskFlow"

export type NewTaskPrompt = Readonly<{ text: string; images?: string[]; files?: string[]; workspacePath?: string }>
export type NewTaskPromptOptions = Readonly<{ broadcast?: boolean; requestId?: string }>

type TaskPromptDependencies = {
	startFlow: StartNewTaskFlow
	interactionFlow: AskResponseInteractionFlow
	sendFlow: SendUserMessageFlow
	isRuntimeAvailable: () => boolean
	activeSessionId: () => string
	selectedSessionId: () => string
	mode: () => "plan" | "act"
	hasPendingApproval: () => boolean
	hasPendingQuestion: () => boolean
	resolveInitialCwd: (requestedWorkspacePath: string) => string
	buildTranscript: (text: string, images: string[], files: string[]) => string
	createRequestId: () => string
	log: (event: string, details: Record<string, unknown>) => void
}

export class TaskPromptFlow {
	constructor(private readonly dependencies: TaskPromptDependencies) {}

	async start(request: NewTaskPrompt, options: NewTaskPromptOptions = {}) {
		const images = request.images ?? []
		const files = request.files ?? []
		const requestedWorkspacePath = request.workspacePath ?? ""
		this.dependencies.startFlow.execute({
			text: request.text,
			images,
			files,
			requestedWorkspacePath,
			initialCwd: this.dependencies.resolveInitialCwd(requestedWorkspacePath),
			requestId: options.requestId || this.dependencies.createRequestId(),
			broadcast: options.broadcast !== false,
		})
	}

	async respond(request: TaskPromptRequest, requestId?: string) {
		if (!this.dependencies.isRuntimeAvailable()) throw new Error("LIG VS SDK runtime is not attached.")
		const { responseType, images, files } = request
		const transcriptText = this.dependencies.buildTranscript(request.text, images, files)
		const activeSessionId = this.dependencies.activeSessionId()
		const selectedSessionId = this.dependencies.selectedSessionId()
		this.dependencies.log("sendAskResponse.received", {
			responseType,
			textLength: transcriptText.length,
			hasPendingApproval: this.dependencies.hasPendingApproval(),
			hasPendingQuestion: this.dependencies.hasPendingQuestion(),
			activeSessionId,
			selectedSessionId,
		})

		const answerText = this.dependencies.buildTranscript(request.answerText, images, files)
		if (await this.dependencies.interactionFlow.handle({ responseType, text: transcriptText, answerText, images, files, activeSessionId })) return
		await this.dependencies.sendFlow.execute({
			requestId: requestId || this.dependencies.createRequestId(),
			prompt: request.text,
			transcriptText,
			images,
			files,
			delivery: normalizeDelivery(request.delivery),
			mode: this.dependencies.mode(),
			activeSessionId,
			selectedSessionId,
		})
	}
}

function normalizeDelivery(value: string): "queue" | "steer" | undefined {
	return value === "queue" || value === "steer" ? value : undefined
}
