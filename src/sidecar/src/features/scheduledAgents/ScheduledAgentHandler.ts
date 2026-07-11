import type { ScheduledAgentStorePort } from "../../application/ports/ScheduledAgentStorePort"
import { getScheduledSpecId } from "./ScheduledAgentPolicy"

type LaunchScheduledTask = (request: Readonly<{ text: string; workspacePath: string; taskSessionId: string }>) => Promise<void>

export class ScheduledAgentHandler {
	constructor(private readonly store: ScheduledAgentStorePort, private readonly isEnabled: () => boolean) {}

	list(workspaceRoot: string) {
		const specs = this.store.listSpecs(workspaceRoot)
		const automationEnabled = this.isEnabled()
		return {
			success: true,
			supported: true,
			workspaceRoot,
			specs,
			items: specs,
			recentRuns: this.store.listRuns(),
			automationEnabled,
			source: workspaceRoot ? this.store.specSource(workspaceRoot) : "",
			message: automationEnabled ? "" : "Scheduled agents are local-only and disabled until scheduled agents are enabled in Visual Studio settings.",
		}
	}

	save(message: unknown, workspaceRoot: string) {
		this.requireWorkspace(workspaceRoot)
		const spec = this.store.saveSpec(workspaceRoot, asRecord(message))
		return { ...this.list(workspaceRoot), success: true, supported: true, spec }
	}

	delete(message: unknown, workspaceRoot: string) {
		this.requireWorkspace(workspaceRoot)
		const specId = getScheduledSpecId(asRecord(message))
		const deleted = this.store.deleteSpec(workspaceRoot, specId)
		return { ...this.list(workspaceRoot), success: deleted, supported: true, deleted, specId }
	}

	async run(message: unknown, workspaceRoot: string, launch: LaunchScheduledTask) {
		this.requireWorkspace(workspaceRoot)
		const request = asRecord(message)
		const specId = getScheduledSpecId(request)
		const spec = this.store.listSpecs(workspaceRoot).find((item) => matchesSpec(item, specId)) || this.store.saveSpec(workspaceRoot, request)
		const prompt = readString(request.prompt) || readString(spec.prompt) || readString(spec.task) || readString(spec.text)
		if (!prompt.trim()) throw new Error("Scheduled agent spec does not contain a prompt/task.")
		const run = this.store.appendRun({ specId: readString(spec.id), name: readString(spec.name), workspaceRoot, status: "started", startedAt: Date.now(), manual: true })
		await launch({ text: prompt, workspacePath: workspaceRoot, taskSessionId: readString(run.runId) })
		return { success: true, supported: true, run, spec, recentRuns: this.store.listRuns() }
	}

	private requireWorkspace(workspaceRoot: string) {
		if (!workspaceRoot) throw new Error("No workspace is open for scheduled agent specs.")
	}
}

function matchesSpec(item: Record<string, unknown>, specId: string) { return [item.id, item.name, item.fileName].some((value) => readString(value) === specId) }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
