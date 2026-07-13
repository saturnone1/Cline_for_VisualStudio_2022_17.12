import type { SettingsCommand } from "../../features/settings/SettingsRpcHandler"

export function decodeSettingsRpcCommand(key: string, message: unknown): SettingsCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "StateService.updateSettings":
		case "StateService.updateAutoApprovalSettings":
		case "ModelsService.updateApiConfigurationProto":
		case "ModelsService.updateApiConfiguration": return { type: "apply", settings: request }
		case "StateService.togglePlanActModeProto": return { type: "toggleMode", requestedMode: readString(request.mode ?? request.value) }
		case "StateService.updateTelemetrySetting": return { type: "setTelemetry", value: readString(request.value ?? request.telemetrySetting) }
		case "StateService.dismissBanner": return { type: "dismissBanner", banner: readString(request.value ?? request.banner ?? request.id), version: readNumber(request.version) }
		case "StateService.updateInfoBannerVersion": return { type: "setBannerVersion", banner: "info", version: readNumber(request.value) || readNumber(request.version) }
		case "StateService.updateModelBannerVersion": return { type: "setBannerVersion", banner: "model", version: readNumber(request.value) || readNumber(request.version) }
		case "StateService.updateCliBannerVersion": return { type: "setBannerVersion", banner: "cli", version: readNumber(request.value) || readNumber(request.version) }
		case "StateService.updateTerminalConnectionTimeout": return { type: "setTerminalTimeout", timeout: readNumber(request.value) || readNumber(request.timeout) || readNumber(request.timeoutMs) }
		case "StateService.setWelcomeViewCompleted": return { type: "completeWelcome" }
		case "StateService.captureOnboardingProgress":
		case "StateService.refreshRemoteConfig":
		case "StateService.testOtelConnection":
		case "StateService.testPromptUploading":
		case "StateService.installClineCli": return { type: "unsupported" }
		case "StateService.toggleFavoriteModel": return { type: "toggleFavorite", modelId: readString(request.value ?? request.modelId) }
		case "StateService.resetState": return { type: "reset" }
		default: return undefined
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
function readNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
