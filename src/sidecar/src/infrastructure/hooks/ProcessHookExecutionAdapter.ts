import type { HookExecutionPort } from "../../application/ports/HookExecutionPort"
import { executeHookScript } from "./HookRuntime"

export class ProcessHookExecutionAdapter implements HookExecutionPort {
	execute(hook: Parameters<HookExecutionPort["execute"]>[0], context: Record<string, unknown>) { return executeHookScript(hook, context) }
}
