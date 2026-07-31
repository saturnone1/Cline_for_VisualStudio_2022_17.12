import { normalizeMcpDisplayMode } from "../conversation/ConversationMessageProjection"
import { compactApiConfiguration, extractApiConfigurationUpdate, extractAutoApprovalSettingsUpdate, isRuntimeSettingsKey, normalizeApiConfiguration, normalizeApiConfigurationProfiles } from "./ProviderConfiguration"
import type { ApiConfigurationProfileManager } from "./ApiConfigurationProfileManager"

type State = Record<string, unknown>
type Callbacks = Readonly<{
	state: () => State
	profiles: ApiConfigurationProfileManager
	refreshWebTools: () => void
	runtimeChanged: () => void
	connectionChanged: () => void
}>

export class SettingsMutationHandler {
	constructor(private readonly callbacks: Callbacks) {}

	apply(message: unknown) {
		const request = asRecord(message), state = this.callbacks.state()
		let runtimeSettingsChanged = false
		let connectionSettingsChanged = false
		const apiConfigurationUpdate = extractApiConfigurationUpdate(request)
		if (Object.keys(apiConfigurationUpdate).length > 0) {
			state.apiConfiguration = normalizeApiConfiguration({ ...asRecord(state.apiConfiguration), ...compactApiConfiguration(apiConfigurationUpdate) })
			this.callbacks.profiles.syncActive()
			connectionSettingsChanged = true
		}
		const autoApprovalUpdate = extractAutoApprovalSettingsUpdate(request)
		if (Object.keys(autoApprovalUpdate).length > 0) {
			const current = asRecord(state.autoApprovalSettings)
			state.autoApprovalSettings = { ...current, ...autoApprovalUpdate, actions: { ...asRecord(current.actions), ...asRecord(autoApprovalUpdate.actions) } }
			runtimeSettingsChanged = true
		}
		if ("browserSettings" in request) {
			state.browserSettings = { ...asRecord(state.browserSettings), ...asRecord(request.browserSettings) }
			this.callbacks.refreshWebTools()
			runtimeSettingsChanged = true
		}
		if (typeof request.clineWebToolsEnabled === "boolean") {
			state.browserSettings = { ...asRecord(state.browserSettings), disableToolUse: request.clineWebToolsEnabled !== true }
			this.callbacks.refreshWebTools()
			runtimeSettingsChanged = true
		}
		if ("focusChainSettings" in request) state.focusChainSettings = { ...asRecord(state.focusChainSettings), ...asRecord(request.focusChainSettings) }
		if ("mcpDisplayMode" in request) state.mcpDisplayMode = normalizeMcpDisplayMode(request.mcpDisplayMode, readString(state.mcpDisplayMode))
		for (const key of SIMPLE_SETTING_KEYS) {
			if (!(key in request) || key === "apiConfiguration" || key === "autoApprovalSettings") continue
			state[key] = request[key]
			if (isRuntimeSettingsKey(key)) runtimeSettingsChanged = true
		}
		if (typeof request.useAutoCondense === "boolean") state.autoCondensePreferenceVersion = 1
		if (request.yoloModeToggled === true) state.mode = "act"
		if ("apiConfigurationProfiles" in request) {
			state.apiConfigurationProfiles = normalizeApiConfigurationProfiles(request.apiConfigurationProfiles, asRecord(state.apiConfiguration), state.planActSeparateModelsSetting === true)
			connectionSettingsChanged = true
		}
		if ("activeApiConfigurationProfileId" in request) {
			this.callbacks.profiles.activate(readString(request.activeApiConfigurationProfileId))
			connectionSettingsChanged = true
		} else if ("apiConfigurationProfiles" in request) this.callbacks.profiles.ensure()
		if ("planActSeparateModelsSetting" in request && !("activeApiConfigurationProfileId" in request)) {
			this.callbacks.profiles.syncActive()
			connectionSettingsChanged = true
		}
		if (connectionSettingsChanged) this.callbacks.connectionChanged()
		if (runtimeSettingsChanged) this.callbacks.runtimeChanged()
	}
}

const SIMPLE_SETTING_KEYS = ["apiConfiguration", "autoApprovalSettings", "mode", "planActSeparateModelsSetting", "uiLanguage", "preferredLanguage", "telemetrySetting", "subagentsEnabled", "scheduledAgentsEnabled", "hooksEnabled", "showFeatureTips", "backgroundEditEnabled", "enableCheckpointsSetting", "yoloModeToggled", "lazyTeammateModeEnabled", "mcpResponsesCollapsed", "enableParallelToolCalling", "strictPlanModeEnabled", "useAutoCondense", "customPrompt", "terminalReuseEnabled", "terminalOutputLineLimit", "defaultTerminalProfile"] as const
function asRecord(value: unknown): State { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as State : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
