import type { SdkSettingToggleRequest, SdkSettingsHandler } from "./SdkSettingsHandler"
import { throwIfOperationCancelled } from "../../application/services/OperationCancellation"

export type InstructionSettingsCommand =
	| Readonly<{ type: "refreshInstructions" }>
	| Readonly<{ type: "refreshSkills" }>
	| Readonly<{ type: "toggle"; settingType: "rules" | "workflows" | "skills"; request: SdkSettingToggleRequest }>

type ToggleMap = Record<string, boolean>
type Callbacks = Readonly<{
	sdkSettings: () => SdkSettingsHandler
	workspaceRoot: () => Promise<string>
	writeInstructions: (value: Readonly<{ globalRules: ToggleMap; localRules: ToggleMap; globalWorkflows: ToggleMap; localWorkflows: ToggleMap }>) => void
	legacyRuleToggles: () => Readonly<{ cursor: ToggleMap; windsurf: ToggleMap; agents: ToggleMap }>
	writeSkills: (value: Readonly<{ global: ToggleMap; local: ToggleMap }>) => void
	addError: (text: string) => void
}>

export class InstructionSettingsRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: InstructionSettingsCommand, signal?: AbortSignal) {
		const cwd = await this.callbacks.workspaceRoot()
		throwIfOperationCancelled(signal)
		if (command.type === "refreshInstructions") return this.refreshInstructions(cwd)
		if (command.type === "refreshSkills") return this.refreshSkills(cwd)
		const result = await this.callbacks.sdkSettings().toggle(command.settingType, command.request, cwd)
		if (!result.success) this.callbacks.addError(result.error)
		return command.settingType === "skills" ? this.refreshSkills(cwd) : this.refreshInstructions(cwd)
	}

	async refresh(kind: "instructions" | "skills") {
		const cwd = await this.callbacks.workspaceRoot()
		if (kind === "skills") await this.refreshSkills(cwd)
		else await this.refreshInstructions(cwd)
	}

	private async refreshInstructions(cwd: string) {
		const result = await this.callbacks.sdkSettings().instructions(cwd)
		const { globalClineRulesToggles: globalRules, localClineRulesToggles: localRules, globalWorkflowToggles: globalWorkflows, localWorkflowToggles: localWorkflows } = result
		this.callbacks.writeInstructions({ globalRules, localRules, globalWorkflows, localWorkflows })
		const legacy = this.callbacks.legacyRuleToggles()
		return { globalClineRulesToggles: { toggles: globalRules }, localClineRulesToggles: { toggles: localRules }, localCursorRulesToggles: { toggles: legacy.cursor }, localWindsurfRulesToggles: { toggles: legacy.windsurf }, localAgentsRulesToggles: { toggles: legacy.agents }, globalWorkflowToggles: { toggles: globalWorkflows }, localWorkflowToggles: { toggles: localWorkflows } }
	}

	private async refreshSkills(cwd: string) {
		const result = await this.callbacks.sdkSettings().skills(cwd)
		this.callbacks.writeSkills({ global: result.globalSkillsToggles, local: result.localSkillsToggles })
		return result
	}
}
