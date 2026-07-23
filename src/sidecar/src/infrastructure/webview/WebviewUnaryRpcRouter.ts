import type { SettingsRpcHandler } from "../../features/settings/SettingsRpcHandler"
import type { AccountRpcHandler } from "../../features/providers/AccountRpcHandler"
import type { BrowserRpcHandler } from "../../features/browser/BrowserRpcHandler"
import type { TerminalRpcHandler } from "../../features/terminal/TerminalRpcHandler"
import type { TaskRpcHandler } from "../../features/chat/TaskRpcHandler"
import type { CheckpointRpcHandler } from "../../features/checkpoints/CheckpointRpcHandler"
import type { HookRpcHandler } from "../../features/hooks/HookRpcHandler"
import type { ScheduledAgentRpcHandler } from "../../features/scheduledAgents/ScheduledAgentRpcHandler"
import type { WorktreeRpcHandler } from "../../features/worktrees/WorktreeRpcHandler"
import type { McpRpcHandler } from "../../features/mcp/McpRpcHandler"
import type { ModelCatalogRpcHandler } from "../../features/providers/ModelCatalogRpcHandler"
import type { FileRpcHandler } from "../../features/files/FileRpcHandler"
import type { InstructionSettingsRpcHandler } from "../../features/settings/InstructionSettingsRpcHandler"
import type { UiWebRpcHandler } from "../../features/web/UiWebRpcHandler"
import type { PluginRpcHandler } from "../../features/plugins/PluginRpcHandler"
import { decodeSettingsRpcCommand } from "./SettingsRpcDecoder"
import { decodeAccountRpcCommand } from "./AccountRpcDecoder"
import { decodeBrowserRpcCommand } from "./BrowserRpcDecoder"
import { decodeTerminalRpcCommand } from "./TerminalRpcDecoder"
import { decodeTaskRpcCommand } from "./TaskRpcDecoder"
import { decodeCheckpointRpcCommand } from "./CheckpointRpcDecoder"
import { decodeHookRpcCommand } from "./HookRpcDecoder"
import { decodeScheduledAgentRpcCommand } from "./ScheduledAgentRpcDecoder"
import { decodeWorktreeRpcCommand } from "./WorktreeRpcDecoder"
import { decodeMcpRpcCommand } from "./McpRpcDecoder"
import { decodeModelCatalogRpcCommand } from "./ModelCatalogRpcDecoder"
import { decodeFileRpcCommand } from "./FileRpcDecoder"
import { decodeInstructionSettingsRpcCommand } from "./InstructionSettingsRpcDecoder"
import { decodeUiWebRpcCommand } from "./UiWebRpcDecoder"
import { decodePluginRpcCommand } from "./PluginRpcDecoder"
import { grpcError, grpcHandled, grpcResponse } from "./WebviewGrpcSupport"
import { webviewRpcOperation, type WebviewRpcSidecarRoute } from "../../application/dto/generated/WebviewRpcContract"

type Dependencies = Readonly<{
	settings: SettingsRpcHandler; account: AccountRpcHandler; browser: BrowserRpcHandler; terminal: TerminalRpcHandler
	task: TaskRpcHandler; checkpoint: CheckpointRpcHandler; hook: HookRpcHandler; scheduledAgent: ScheduledAgentRpcHandler
	worktree: WorktreeRpcHandler; mcp: McpRpcHandler; modelCatalog: ModelCatalogRpcHandler; file: FileRpcHandler
	instructionSettings: InstructionSettingsRpcHandler; uiWeb: UiWebRpcHandler; plugin: PluginRpcHandler
	stateMessages: () => unknown[]; mcpStreamMessages: (payload: unknown) => unknown[]
}>

type UnaryRoute = Exclude<WebviewRpcSidecarRoute, "stream">
type UnaryRouteResult = ReturnType<typeof grpcHandled> | null
type UnaryRouteHandler = (key: string, requestId: string, message: unknown, signal: AbortSignal) => Promise<UnaryRouteResult>
type UnaryRouteRegistry = Record<UnaryRoute, UnaryRouteHandler>

export class WebviewRpcRequestCancelledError extends Error {
	constructor(readonly requestId: string) {
		super(`WebView RPC request was cancelled: ${requestId}`)
		this.name = "WebviewRpcRequestCancelledError"
	}
}

export function isWebviewRpcRequestCancelledError(error: unknown): error is WebviewRpcRequestCancelledError {
	return error instanceof WebviewRpcRequestCancelledError
}

export class WebviewUnaryRpcRouter {
	private readonly routes: UnaryRouteRegistry
	private readonly activeRequests = new Map<string, AbortController>()
	private controlTail: Promise<void> = Promise.resolve()

	constructor(private readonly dependencies: Dependencies) {
		const d = dependencies
		this.routes = {
			settings: async (key, requestId, message, signal) => {
				const command = decodeSettingsRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.settings.handle(command, signal)) : null
			},
			account: async (key, requestId, message, signal) => {
				const command = decodeAccountRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.account.handle(command, signal)) : null
			},
			browser: async (key, requestId, message) => {
				const command = decodeBrowserRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.browser.handle(command), false)) : null
			},
			terminal: async (key, requestId, message) => {
				const command = decodeTerminalRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.terminal.handle(command)) : null
			},
			task: async (key, requestId, message, signal) => {
				const command = decodeTaskRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.task.handle(command, requestId, signal)) : null
			},
			checkpoint: async (key, requestId, message, signal) => {
				const command = decodeCheckpointRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.checkpoint.handle(command, signal)) : null
			},
			hook: async (key, requestId, message) => {
				const command = decodeHookRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.hook.handle(command), false)) : null
			},
			scheduledAgent: async (key, requestId, message, signal) => {
				const command = decodeScheduledAgentRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.scheduledAgent.handle(command, signal)) : null
			},
			worktree: async (key, requestId, message) => {
				const command = decodeWorktreeRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.worktree.handle(command), false)) : null
			},
			mcp: (key, requestId, message, signal) => this.handleMcp(key, requestId, message, signal),
			modelCatalog: async (key, requestId, message, signal) => {
				const command = decodeModelCatalogRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.modelCatalog.handle(command, signal), false)) : null
			},
			file: (key, requestId, message) => this.handleFile(key, requestId, message),
			instructionSettings: async (key, requestId, message, signal) => {
				const command = decodeInstructionSettingsRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.instructionSettings.handle(command, signal), false)) : null
			},
			uiWeb: async (key, requestId, message) => {
				const command = decodeUiWebRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.uiWeb.handle(command), false)) : null
			},
			plugin: async (key, requestId) => {
				const command = decodePluginRpcCommand(key)
				return command ? grpcHandled(grpcResponse(requestId, await d.plugin.handle(command), false)) : null
			},
		}
	}

	async handle(key: string, requestId: string, message: unknown) {
		const separator = key.indexOf(".")
		const operation = separator > 0 ? webviewRpcOperation(key.slice(0, separator), key.slice(separator + 1)) : undefined
		const route = operation && "route" in operation ? operation.route : undefined
		if (!route || route === "stream") return null
		const controller = new AbortController()
		this.activeRequests.get(requestId)?.abort()
		this.activeRequests.set(requestId, controller)
		try {
			const execute = () => this.routes[route](key, requestId, message, controller.signal)
			const result = CONTROL_ROUTES.has(route)
				? await this.executeControl(execute, controller.signal, requestId)
				: await execute()
			if (controller.signal.aborted) throw new WebviewRpcRequestCancelledError(requestId)
			return result
		} catch (error) {
			if (controller.signal.aborted && !isWebviewRpcRequestCancelledError(error)) {
				throw new WebviewRpcRequestCancelledError(requestId)
			}
			throw error
		} finally {
			if (this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId)
		}
	}

	private executeControl<T>(action: () => Promise<T>, signal: AbortSignal, requestId: string) {
		let started = false
		const execution = this.controlTail.then(async () => {
			if (signal.aborted) throw new WebviewRpcRequestCancelledError(requestId)
			started = true
			return action()
		})
		this.controlTail = execution.then(() => undefined, () => undefined)
		return waitForControlExecution(execution, signal, requestId, () => started)
	}

	cancel(requestId: string) {
		const controller = this.activeRequests.get(requestId)
		if (!controller) return false
		controller.abort()
		return true
	}

	private async handleMcp(key: string, requestId: string, message: unknown, signal: AbortSignal) {
		const command = decodeMcpRpcCommand(key, message)
		if (!command) return null
		const result = await this.dependencies.mcp.handle(command, signal)
		if (result.error) return grpcHandled(grpcError(requestId, result.error, false))
		return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.publishToStreams ? this.dependencies.mcpStreamMessages(result.payload) : []))
	}

	private async handleFile(key: string, requestId: string, message: unknown) {
		const command = decodeFileRpcCommand(key, message)
		if (!command) return null
		const result = await this.dependencies.file.handle(command)
		return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.includeStateMessages ? this.dependencies.stateMessages() : []))
	}

	private withOptionalState(requestId: string, result: { payload: unknown; includeStateMessages?: boolean }) {
		return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.includeStateMessages ? this.dependencies.stateMessages() : []))
	}
}

const CONTROL_ROUTES = new Set<UnaryRoute>([
	"settings",
	"account",
	"task",
	"checkpoint",
	"scheduledAgent",
	"mcp",
	"instructionSettings",
])

function waitForControlExecution<T>(operation: Promise<T>, signal: AbortSignal, requestId: string, hasStarted: () => boolean) {
	if (signal.aborted) return Promise.reject(new WebviewRpcRequestCancelledError(requestId))
	return new Promise<T>((resolve, reject) => {
		const abortQueuedRequest = () => {
			if (!hasStarted()) reject(new WebviewRpcRequestCancelledError(requestId))
		}
		signal.addEventListener("abort", abortQueuedRequest, { once: true })
		operation.then(
			(value) => { signal.removeEventListener("abort", abortQueuedRequest); resolve(value) },
			(error) => { signal.removeEventListener("abort", abortQueuedRequest); reject(error) },
		)
	})
}
