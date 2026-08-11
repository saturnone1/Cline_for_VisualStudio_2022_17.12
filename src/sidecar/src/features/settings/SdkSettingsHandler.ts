import type { AgentEnginePort } from "../../application/ports/AgentEnginePort"

export class SdkSettingsHandler {
	constructor(private readonly agentEngine: AgentEnginePort) {}

	async instructions(cwd: string) {
		const snapshot = await this.snapshot(cwd), rules = records(snapshot.rules), workflows = records(snapshot.workflows)
		const globalClineRulesToggles = toggleMap(rules, "global"), localClineRulesToggles = toggleMap(rules, "local"), globalWorkflowToggles = toggleMap(workflows, "global"), localWorkflowToggles = toggleMap(workflows, "local")
		return { globalClineRulesToggles, localClineRulesToggles, globalWorkflowToggles, localWorkflowToggles }
	}

	async skills(cwd: string) {
		const skills = records((await this.snapshot(cwd)).skills), globalSkills = skills.filter(isGlobal).map(toSkill), localSkills = skills.filter((item) => !isGlobal(item)).map(toSkill)
		return { globalSkills, localSkills, globalSkillsToggles: Object.fromEntries(globalSkills.map((skill) => [skill.path, skill.enabled])), localSkillsToggles: Object.fromEntries(localSkills.map((skill) => [skill.path, skill.enabled])) }
	}

	async toggle(type: "rules" | "workflows" | "skills", request: SdkSettingToggleRequest, cwd: string): Promise<{ success: true } | { success: false; error: string }> {
		try { await this.agentEngine.toggleSetting({ type, path: request.path, enabled: request.enabled, cwd, workspaceRoot: cwd }); return { success: true } }
		catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
	}

	private async snapshot(cwd: string) { try { return asRecord(await this.agentEngine.listSettings({ cwd, workspaceRoot: cwd })) } catch { return {} } }
}

export type SdkSettingToggleRequest = Readonly<{ path: string; enabled: boolean }>

function records(value: unknown) { return Array.isArray(value) ? value.map(asRecord) : [] }
function toggleMap(items: Record<string, unknown>[], scope: "global" | "local") { return Object.fromEntries(items.filter((item) => scope === "global" ? isGlobal(item) : !isGlobal(item)).map((item) => [key(item), item.enabled !== false])) }
function isGlobal(item: Record<string, unknown>) { const source = readString(item.source); return source === "global" || source === "global-plugin" || readString(item.path).toLowerCase().includes("\\cline\\") }
function key(item: Record<string, unknown>) { return readString(item.path) || readString(item.id) || readString(item.name) }
function toSkill(item: Record<string, unknown>) { return { name: readString(item.name) || key(item), path: key(item), enabled: item.enabled !== false, description: readString(item.description) } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
