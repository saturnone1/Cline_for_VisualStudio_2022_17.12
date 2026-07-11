import { normalizeProviderId } from "../../application/services/ProviderIdentity"

export type AgentMode = "plan" | "act"

export function selectProvider(apiConfig: Record<string, unknown>, mode: string, fallbackProvider = "anthropic") {
	const modePrefix = mode === "plan" ? "planMode" : "actMode"
	const providerId = normalizeProviderId(readString(apiConfig[`${modePrefix}ApiProvider`]) || fallbackProvider)
	return { modePrefix, providerId, modelId: resolveModelId(apiConfig, providerId, modePrefix) }
}

export function resolveModelId(apiConfig: Record<string, unknown>, providerId: string, modePrefix: string) {
	const providerModelFields: Record<string, string> = {
		anthropic: `${modePrefix}ApiModelId`,
		openrouter: `${modePrefix}OpenRouterModelId`,
		openai: `${modePrefix}OpenAiModelId`,
		"openai-compatible": `${modePrefix}OpenAiModelId`,
		gemini: `${modePrefix}GeminiModelId`,
		ollama: `${modePrefix}OllamaModelId`,
		lmstudio: `${modePrefix}LmStudioModelId`,
		litellm: `${modePrefix}LiteLlmModelId`,
		requesty: `${modePrefix}RequestyModelId`,
		together: `${modePrefix}TogetherModelId`,
		fireworks: `${modePrefix}FireworksModelId`,
		groq: `${modePrefix}GroqModelId`,
		baseten: `${modePrefix}BasetenModelId`,
		huggingface: `${modePrefix}HuggingFaceModelId`,
		"vercel-ai-gateway": `${modePrefix}VercelAiGatewayModelId`,
		aihubmix: `${modePrefix}AihubmixModelId`,
		hicap: `${modePrefix}HicapModelId`,
		oca: `${modePrefix}OcaModelId`,
	}
	const providerSpecific = readString(apiConfig[providerModelFields[providerId]])
	if (providerSpecific) return providerSpecific
	if (providerId === "ollama") return ""
	return readString(apiConfig[`${modePrefix}ApiModelId`]) || readString(apiConfig[`${modePrefix}OpenAiModelId`])
}

function readString(value: unknown) {
	return typeof value === "string" ? value.trim() : ""
}
