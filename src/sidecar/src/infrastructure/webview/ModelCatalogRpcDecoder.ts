import type { ModelCatalogCommand } from "../../features/providers/ModelCatalogRpcHandler"
import { extractApiConfigurationUpdate } from "../configuration/ProviderConfiguration"

const providersByMethod: Readonly<Record<string, string>> = {
	"ModelsService.getLmStudioModels": "lmstudio",
	"ModelsService.refreshOpenAiModels": "openai-compatible",
	"ModelsService.refreshLiteLlmModelsRpc": "litellm",
	"ModelsService.refreshOpenRouterModelsRpc": "openrouter",
	"ModelsService.refreshRequestyModels": "requesty",
	"ModelsService.refreshGroqModelsRpc": "groq",
	"ModelsService.refreshVercelAiGatewayModelsRpc": "vercel-ai-gateway",
	"ModelsService.refreshHicapModels": "hicap",
	"ModelsService.getAihubmixModels": "aihubmix",
	"ModelsService.refreshOcaModels": "oca",
	"ModelsService.refreshBasetenModelsRpc": "baseten",
	"ModelsService.refreshHuggingFaceModels": "huggingface",
	"ModelsService.getSapAiCoreModels": "sapaicore",
}

export function decodeModelCatalogRpcCommand(key: string, message: unknown): ModelCatalogCommand | undefined {
	const request = asRecord(message)
	if (key === "ModelsService.getOllamaModels") return { type: "ollamaValues", baseUrl: readString(request.value) }
	if (key === "ModelsService.getAskSageModels") return { type: "askSage", baseUrl: readString(request.baseUrl) }
	if (key === "ModelsService.getOpenRouterKeyInfo") return { type: "openRouterKeyInfo", apiKey: readString(request.apiKey) }
	const providerId = providersByMethod[key]
	if (providerId) return { type: "refresh", providerId, request: { baseUrl: readString(request.baseUrl) || readString(request.baseURL) || readString(request.url) || readString(request.value), apiConfigurationUpdate: extractApiConfigurationUpdate(request) } }
	if (["ModelsService.getVsCodeLmModels", "ModelsService.refreshClineModelsRpc", "ModelsService.refreshClineRecommendedModelsRpc"].includes(key)) return { type: "unsupported", key }
	return undefined
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
