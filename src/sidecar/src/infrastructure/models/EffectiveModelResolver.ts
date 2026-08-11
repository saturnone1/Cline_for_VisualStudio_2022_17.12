import { resolveModelId } from "../../features/providers/ProviderSelection"
import { getOllamaModels } from "./ModelCatalog"

export async function resolveEffectiveModelId(configuration: Record<string, unknown>, providerId: string, modePrefix: string, baseUrl: string, applyDefaultOllamaModel: (modelId: string) => void) {
	let modelId = resolveModelId(configuration, providerId, modePrefix)
	if (providerId !== "ollama") return modelId || process.env.CLINE_MODEL_ID || "claude-sonnet-4-6"
	if (!modelId || modelId === "claude-sonnet-4-6") modelId = process.env.OLLAMA_MODEL || process.env.CLINE_MODEL_ID || ""
	if (!modelId || modelId === "claude-sonnet-4-6") {
		modelId = (await getOllamaModels(baseUrl))[0] || ""
		if (modelId) applyDefaultOllamaModel(modelId)
	}
	if (!modelId || modelId === "claude-sonnet-4-6") throw new Error(`No local Ollama model is configured. Start Ollama and pull a model, for example: ollama pull llama3.1. Base URL: ${baseUrl || "http://localhost:11434"}`)
	return modelId
}
