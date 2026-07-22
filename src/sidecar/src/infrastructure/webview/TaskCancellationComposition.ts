import { TaskCancellationCoordinator, type TaskCancellationResult } from "../../features/runtime/TaskCancellationCoordinator"

type Dependencies = Readonly<{
	abortAgent: (sessionId: string) => Promise<void>
	cancelTerminal: () => Promise<void>
	cancelHooks: () => Promise<void>
	cancelBrowser: () => Promise<void>
	timeoutMs: () => number
	log: (event: string, details: Record<string, unknown>) => void
}>

export type CancelTaskWork = (sessionId: string) => Promise<TaskCancellationResult>

export function createTaskCancellationComposition(dependencies: Dependencies): CancelTaskWork {
	const coordinator = new TaskCancellationCoordinator(dependencies.timeoutMs, dependencies.log)
	return (sessionId) => coordinator.cancel([
		...(sessionId ? [{ name: "agent-and-mcp", cancel: () => dependencies.abortAgent(sessionId) }] : []),
		{ name: "terminal", cancel: dependencies.cancelTerminal },
		{ name: "hooks", cancel: dependencies.cancelHooks },
		{ name: "browser", cancel: dependencies.cancelBrowser },
	])
}
