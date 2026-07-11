import path from "node:path"
import type { ScheduledAgentStorePort } from "../../application/ports/ScheduledAgentStorePort"
import { appendScheduledAgentRun, deleteScheduledAgentSpecFile, readScheduledAgentRuns, readScheduledAgentSpecs, writeScheduledAgentSpec } from "./LocalAutomationStore"

export class LocalScheduledAgentStore implements ScheduledAgentStorePort {
	listSpecs(workspaceRoot: string) { return readScheduledAgentSpecs(workspaceRoot) }
	saveSpec(workspaceRoot: string, request: Record<string, unknown>) { return writeScheduledAgentSpec(workspaceRoot, request) }
	deleteSpec(workspaceRoot: string, specId: string) { return deleteScheduledAgentSpecFile(workspaceRoot, specId) }
	listRuns() { return readScheduledAgentRuns() }
	appendRun(run: Record<string, unknown>) { return appendScheduledAgentRun(run) }
	specSource(workspaceRoot: string) { return path.join(workspaceRoot, ".cline", "cron") }
}
