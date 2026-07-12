import { normalizeProviderId } from "../../application/services/ProviderIdentity"
import { resolveModelId, selectProvider } from "../../features/providers/ProviderSelection"
import { resolveConfiguredContextWindow } from "../configuration/ProviderConfiguration"

type RuntimeModelContextDependencies = {
	configuration: () => Record<string, unknown>
	mode: () => "plan" | "act"
	defaultModelId: () => string
	defaultOllamaModelId: () => string
	maxResumedConversationChars: number
}

export class RuntimeModelContext {
	constructor(private readonly dependencies: RuntimeModelContextDependencies) {}

	modelId() {
		const configuration = this.dependencies.configuration()
		const { modePrefix, providerId } = selectProvider(configuration, this.dependencies.mode())
		if (providerId === "ollama") return resolveModelId(configuration, providerId, modePrefix) || this.dependencies.defaultOllamaModelId() || "ollama"
		return resolveModelId(configuration, providerId, modePrefix) || this.dependencies.defaultModelId() || "claude-sonnet-4-6"
	}

	resumedConversationCharBudget() {
		const configuration = this.dependencies.configuration()
		const modePrefix = this.dependencies.mode() === "plan" ? "planMode" : "actMode"
		const providerId = normalizeProviderId(stringValue(configuration[`${modePrefix}ApiProvider`]) || "anthropic")
		const contextWindowTokens = resolveConfiguredContextWindow(configuration, providerId, modePrefix, this.modelId())
		return contextWindowTokens
			? Math.min(this.dependencies.maxResumedConversationChars, Math.max(2_000, Math.floor(contextWindowTokens * 0.5)))
			: this.dependencies.maxResumedConversationChars
	}
}

function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
