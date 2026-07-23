import { normalizeMcpDisplayMode } from "../conversation/ConversationMessageProjection"
import { compactApiConfiguration, extractApiConfigurationUpdate, extractAutoApprovalSettingsUpdate, isRuntimeSettingsKey, normalizeApiConfiguration, normalizeApiConfigurationProfiles } from "./ProviderConfiguration"
import type { ApiConfigurationProfileManager } from "./ApiConfigurationProfileManager"

type State = Record<string, unknown>
type Callbacks = Readonly<{
	state: () => State
	profiles: ApiConfigurationProfileManager
	refreshWebTools: () => void
	runtimeChanged: () => void
}>

export class SettingsMutationHandler {
	constructor(private readonly callbacks: Callbacks) {}

	apply(message: unknown) {
		const request = asRecord(message), state = this.callbacks.state()
		let runtimeSettingsChanged = false
		const apiConfigurationUpdate = extractApiConfigurationUpdate(request)
		if (Object.keys(apiConfigurationUpdate).length > 0) {
			state.apiConfiguration = normalizeApiConfiguration({ ...asRecord(state.apiConfiguration), ...compactApiConfiguration(apiConfigurationUpdate) })
			this.callbacks.profiles.syncActive()
			runtimeSettingsChanged = true
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
			state[key === "nativeToolCallEnabled" ? "nativeToolCallSetting" : key] = request[key]
			if (isRuntimeSettingsKey(key)) runtimeSettingsChanged = true
		}
		if (request.yoloModeToggled === true) state.mode = "act"
		if ("apiConfigurationProfiles" in request) {
			state.apiConfigurationProfiles = normalizeApiConfigurationProfiles(request.apiConfigurationProfiles, asRecord(state.apiConfiguration), state.planActSeparateModelsSetting === true)
			runtimeSettingsChanged = true
		}
		if ("activeApiConfigurationProfileId" in request) {
			this.callbacks.profiles.activate(readString(request.activeApiConfigurationProfileId))
			runtimeSettingsChanged = true
		} else if ("apiConfigurationProfiles" in request) this.callbacks.profiles.ensure()
		if ("planActSeparateModelsSetting" in request && !("activeApiConfigurationProfileId" in request)) {
			this.callbacks.profiles.syncActive()
			runtimeSettingsChanged = true
		}
		if (runtimeSettingsChanged) this.callbacks.runtimeChanged()
	}
}

const SIMPLE_SETTING_KEYS = ["apiConfiguration", "autoApprovalSettings", "mode", "planActSeparateModelsSetting", "uiLanguage", "preferredLanguage", "telemetrySetting", "subagentsEnabled", "scheduledAgentsEnabled", "hooksEnabled", "showFeatureTips", "backgroundEditEnabled", "enableCheckpointsSetting", "yoloModeToggled", "doubleCheckCompletionEnabled", "lazyTeammateModeEnabled", "mcpResponsesCollapsed", "enableParallelToolCalling", "nativeToolCallEnabled", "strictPlanModeEnabled", "useAutoCondense", "customPrompt"] as const
function asRecord(value: unknown): State { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as State : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
