import { normalizeProviderId } from "../../application/services/ProviderIdentity"
import { resolveModelId, selectProvider } from "../../features/providers/ProviderSelection"
import { resolveConfiguredContextWindow } from "../configuration/ProviderConfiguration"
import { readBoundedPositiveIntEnv } from "../configuration/RuntimeEnvironment"

type RuntimeModelContextDependencies = {
	configuration: () => Record<string, unknown>
	mode: () => "plan" | "act"
	defaultModelId: () => string
	defaultOllamaModelId: () => string
}

export class RuntimeModelContext {
	constructor(private readonly dependencies: RuntimeModelContextDependencies) {}

	modelId() {
		const configuration = this.dependencies.configuration()
		const { modePrefix, providerId } = selectProvider(configuration, this.dependencies.mode())
		if (providerId === "ollama") return resolveModelId(configuration, providerId, modePrefix) || this.dependencies.defaultOllamaModelId() || "ollama"
		return resolveModelId(configuration, providerId, modePrefix) || this.dependencies.defaultModelId() || "claude-sonnet-4-6"
	}

	resumedConversationTokenBudget() {
		const configuration = this.dependencies.configuration()
		const modePrefix = this.dependencies.mode() === "plan" ? "planMode" : "actMode"
		const providerId = normalizeProviderId(stringValue(configuration[`${modePrefix}ApiProvider`]) || "anthropic")
		const contextWindowTokens = resolveConfiguredContextWindow(configuration, providerId, modePrefix, this.modelId())
		if (!contextWindowTokens) return undefined
		const percentage = readBoundedPositiveIntEnv("VSCLINE_RESUMED_CONTEXT_PERCENT", 60, 10, 90)
		return Math.max(1, Math.floor(contextWindowTokens * percentage / 100))
	}
}

function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
