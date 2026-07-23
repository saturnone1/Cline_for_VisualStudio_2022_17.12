import { resolveRequestedPlanActMode } from "./PlanActMode"
import { throwIfOperationCancelled } from "../../application/services/OperationCancellation"

type State = Record<string, unknown>

export type SettingsCommand =
	| Readonly<{ type: "apply"; settings: Record<string, unknown> }>
	| Readonly<{ type: "toggleMode"; requestedMode: string }>
	| Readonly<{ type: "setTelemetry"; value: string }>
	| Readonly<{ type: "dismissBanner"; banner: string; version?: number }>
	| Readonly<{ type: "setBannerVersion"; banner: "info" | "model" | "cli"; version?: number }>
	| Readonly<{ type: "setTerminalTimeout"; timeout?: number }>
	| Readonly<{ type: "completeWelcome" }>
	| Readonly<{ type: "unsupported" }>
	| Readonly<{ type: "toggleFavorite"; modelId: string }>
	| Readonly<{ type: "reset" }>

export type SettingsRpcResult = Readonly<{ payload: Record<string, unknown>; includeStateMessages?: boolean }>

type SettingsRpcCallbacks = Readonly<{
	state: () => State
	applySettings: (settings: Record<string, unknown>) => void
	persist: () => void
	broadcast: () => Promise<void>
	clearPersistedState: () => void
	resetState: () => void
	clearTask: () => Promise<void>
}>

export class SettingsRpcHandler {
	constructor(private readonly callbacks: SettingsRpcCallbacks) {}

	async handle(command: SettingsCommand, signal?: AbortSignal): Promise<SettingsRpcResult> {
		throwIfOperationCancelled(signal)
		const state = this.callbacks.state()
		switch (command.type) {
			case "apply":
				this.callbacks.applySettings(command.settings)
				this.callbacks.persist()
				return { payload: {}, includeStateMessages: true }
			case "toggleMode":
				state.mode = resolveRequestedPlanActMode({ value: command.requestedMode }, readString(state.mode))
				this.callbacks.persist()
				await this.callbacks.broadcast()
				return { payload: { value: true, mode: state.mode } }
			case "setTelemetry":
				state.telemetrySetting = command.value || state.telemetrySetting
				return this.broadcastEmpty()
			case "dismissBanner":
				applyBannerDismissal(state, command.banner, command.version)
				return this.broadcastEmpty()
			case "setBannerVersion":
				setBannerVersion(state, command.banner, command.version)
				return this.broadcastEmpty()
			case "setTerminalTimeout":
				state.shellIntegrationTimeout = command.timeout || state.shellIntegrationTimeout
				return this.broadcastEmpty()
			case "completeWelcome":
				state.welcomeViewCompleted = true
				state.isNewUser = false
				return this.broadcastEmpty()
			case "unsupported":
				return { payload: { value: false } }
			case "toggleFavorite":
				toggleFavoriteModel(state, command.modelId)
				return this.broadcastEmpty()
			case "reset":
				throwIfOperationCancelled(signal)
				this.callbacks.clearPersistedState()
				this.callbacks.resetState()
				await this.callbacks.clearTask()
				return { payload: {} }
		}
	}

	private async broadcastEmpty(): Promise<SettingsRpcResult> {
		this.callbacks.persist()
		await this.callbacks.broadcast()
		return { payload: {} }
	}
}

function toggleFavoriteModel(state: State, modelId: string) {
	if (!modelId) return
	const current = new Set(Array.isArray(state.favoritedModelIds) ? state.favoritedModelIds.filter((value): value is string => typeof value === "string") : [])
	if (current.has(modelId)) current.delete(modelId)
	else current.add(modelId)
	state.favoritedModelIds = [...current]
}

function applyBannerDismissal(state: State, banner: string, requestedVersion?: number) {
	const version = requestedVersion || Date.now()
	if (banner.includes("model")) state.lastDismissedModelBannerVersion = version
	else if (banner.includes("cli")) state.lastDismissedCliBannerVersion = version
	else state.lastDismissedInfoBannerVersion = version
}

function setBannerVersion(state: State, banner: "info" | "model" | "cli", version?: number) {
	const key = banner === "model" ? "lastDismissedModelBannerVersion" : banner === "cli" ? "lastDismissedCliBannerVersion" : "lastDismissedInfoBannerVersion"
	state[key] = version || state[key]
}

function readString(value: unknown) {
	return typeof value === "string" ? value : ""
}
