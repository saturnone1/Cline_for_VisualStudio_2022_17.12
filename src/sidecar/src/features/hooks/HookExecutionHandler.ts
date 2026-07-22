import type { HookExecutionResult, HookLifecycleName, HookScript } from "../../application/dto/HookContracts"
import type { HookExecutionPort } from "../../application/ports/HookExecutionPort"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import { extractHookJsonResponse, hookDecisionFromResponse, mergeOptionalRecords, type PreToolUseDecision } from "./HookPolicy"
import type { HookSettingsHandler } from "./HookSettingsHandler"

export type HookExecutionObserver = Readonly<{
	started?: (hook: HookScript, context: Record<string, unknown>) => Promise<void>
	completed?: (result: HookExecutionResult, context: Record<string, unknown>) => Promise<void>
}>

export class HookExecutionHandler {
	constructor(private readonly settings: HookSettingsHandler, private readonly execution: HookExecutionPort, private readonly logger: InteractionLoggerPort) {}

	async run(hookName: HookLifecycleName, context: Record<string, unknown>, workspaceRoot: string, enabled: boolean, observer: HookExecutionObserver = {}) {
		if (!enabled) return []
		const executionContext = { ...context, hookName, workspaceRoot }
		const scripts = this.settings.scripts(workspaceRoot).filter((hook) => hook.name === hookName && hook.enabled)
		const results: HookExecutionResult[] = []
		for (const hook of scripts) {
			await observer.started?.(hook, executionContext)
			const processResult = await this.execution.execute(hook, executionContext)
			const result: HookExecutionResult = { hook, ...processResult, jsonResponse: extractHookJsonResponse(processResult.stdout) }
			results.push(result)
			await observer.completed?.(result, executionContext)
		}
		return results
	}

	async preToolUse(context: Record<string, unknown>, workspaceRoot: string, enabled: boolean, observer: HookExecutionObserver = {}) {
		const results = await this.run("PreToolUse", context, workspaceRoot, enabled, observer)
		let combined: PreToolUseDecision = { blocked: false, reason: "" }
		for (const result of results) {
			const decision = hookDecisionFromResponse(result.jsonResponse)
			if (decision.blocked) {
				this.logger.log("sidecar", "preToolUseBlocked", { hookName: result.hook.name, scriptPath: result.hook.path, reason: decision.reason })
				return decision
			}
			combined = mergeDecision(combined, decision)
		}
		return combined
	}

	cancelAll() { return this.execution.cancelAll() }
}

function mergeDecision(current: PreToolUseDecision, next: PreToolUseDecision): PreToolUseDecision {
	const hasPatch = Boolean(next.inputPatch && Object.keys(next.inputPatch).length > 0)
	if (!hasPatch && !next.validationMessage && !next.contextPatch && !next.structuredDecision) return current
	return {
		blocked: false,
		reason: next.reason || current.reason,
		inputPatch: hasPatch ? { ...(current.replaceInput ? {} : current.inputPatch), ...next.inputPatch } : current.inputPatch,
		replaceInput: hasPatch ? next.replaceInput === true || current.replaceInput === true : current.replaceInput,
		validationMessage: next.validationMessage || current.validationMessage,
		contextPatch: mergeOptionalRecords(current.contextPatch, next.contextPatch),
		structuredDecision: mergeOptionalRecords(current.structuredDecision, next.structuredDecision),
	}
}
