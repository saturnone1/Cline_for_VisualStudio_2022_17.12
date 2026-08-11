import type { HookLifecycleName } from "../../application/dto/HookContracts"
import type { HookExecutionHandler, HookExecutionObserver } from "./HookExecutionHandler"
import { createHookMetadata, type PreToolUseDecision } from "./HookPolicy"

type Message = Record<string, unknown>

type HookLifecycleCallbacks = {
	execution: () => HookExecutionHandler
	workspaceRoot: () => Promise<string>
	enabled: () => boolean
	addMessage: (message: Message) => Message | undefined
	nextTimestamp: () => number
	upsertMessage: (timestamp: number, updates: Message) => void
	updateTask: () => void
	broadcast: () => Promise<void>
}

export class HookLifecycleCoordinator {
	constructor(private readonly callbacks: HookLifecycleCallbacks) {}

	async run(hookName: HookLifecycleName, context: Message = {}) {
		const workspaceRoot = await this.callbacks.workspaceRoot().catch(() => "")
		return this.callbacks.execution().run(hookName, context, workspaceRoot, this.callbacks.enabled(), this.createObserver())
	}

	async preToolUse(context: Message): Promise<PreToolUseDecision> {
		const workspaceRoot = await this.callbacks.workspaceRoot().catch(() => "")
		return this.callbacks.execution().preToolUse(context, workspaceRoot, this.callbacks.enabled(), this.createObserver())
	}

	private createObserver(): HookExecutionObserver {
		const messageIds = new Map<string, number>()
		return {
			started: async (hook, context) => {
				const message = this.callbacks.addMessage({ type: "say", say: "hook_status", text: JSON.stringify(createHookMetadata(hook, "running", context)) })
				const timestamp = Number(message?.ts)
				if (!Number.isFinite(timestamp)) return
				messageIds.set(hookKey(hook), timestamp)
				this.callbacks.updateTask()
				await this.callbacks.broadcast()
			},
			completed: async (result, context) => {
				const timestamp = messageIds.get(hookKey(result.hook)) || this.callbacks.nextTimestamp()
				const metadata = createHookMetadata(result.hook, result.exitCode === 0 ? "completed" : "failed", context, result, result.jsonResponse)
				const output = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n\n")
				this.callbacks.upsertMessage(timestamp, { type: "say", say: "hook_status", text: output ? `${JSON.stringify(metadata)}\n__HOOK_OUTPUT__\n${output}` : JSON.stringify(metadata) })
				this.callbacks.updateTask()
				await this.callbacks.broadcast()
			},
		}
	}
}

function hookKey(hook: { source: string; name: string; path: string }) {
	return `${hook.source}:${hook.name}:${hook.path}`
}
