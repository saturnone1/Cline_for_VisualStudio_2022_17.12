import type { HookExecutionPort } from "../../application/ports/HookExecutionPort"
import { HookProcessRegistry, executeHookScript } from "./HookRuntime"

export class ProcessHookExecutionAdapter implements HookExecutionPort {
	private readonly processes = new HookProcessRegistry()
	execute(hook: Parameters<HookExecutionPort["execute"]>[0], context: Record<string, unknown>) { return executeHookScript(hook, context, this.processes) }
	cancelAll() { return this.processes.cancelAll() }
}
