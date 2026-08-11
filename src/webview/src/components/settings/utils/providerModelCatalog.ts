import {
	ApiConfiguration,
	ApiProvider,
	anthropicDefaultModelId,
	anthropicModels,
	askSageDefaultModelId,
	askSageModels,
	basetenDefaultModelId,
	basetenModels,
	bedrockDefaultModelId,
	bedrockModels,
	cerebrasDefaultModelId,
	cerebrasModels,
	claudeCodeDefaultModelId,
	claudeCodeModels,
	deepSeekDefaultModelId,
	deepSeekModels,
	doubaoDefaultModelId,
	doubaoModels,
	fireworksDefaultModelId,
	fireworksModels,
	geminiDefaultModelId,
	geminiModels,
	groqDefaultModelId,
	groqModels,
	hicapModelInfoSaneDefaults,
	huaweiCloudMaasDefaultModelId,
	huaweiCloudMaasModels,
	huggingFaceDefaultModelId,
	huggingFaceModels,
	internationalQwenDefaultModelId,
	internationalQwenModels,
	internationalZAiDefaultModelId,
	internationalZAiModels,
	liteLlmModelInfoSaneDefaults,
	ModelInfo,
	mainlandQwenDefaultModelId,
	mainlandQwenModels,
	mainlandZAiDefaultModelId,
	mainlandZAiModels,
	minimaxDefaultModelId,
	minimaxModels,
	mistralDefaultModelId,
	mistralModels,
	moonshotDefaultModelId,
	moonshotModels,
	nebiusDefaultModelId,
	nebiusModels,
	nousResearchDefaultModelId,
	nousResearchModels,
	openAiCodexDefaultModelId,
	openAiCodexModels,
	openAiModelInfoSaneDefaults,
	openAiNativeDefaultModelId,
	openAiNativeModels,
	openRouterDefaultModelId,
	openRouterDefaultModelInfo,
	qwenCodeDefaultModelId,
	qwenCodeModels,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
	sambanovaDefaultModelId,
	sambanovaModels,
	sapAiCoreDefaultModelId,
	sapAiCoreModels,
	vertexDefaultModelId,
	vertexModels,
	wandbDefaultModelId,
	wandbModels,
	xaiDefaultModelId,
	xaiModels,
} from "@shared/api"
import { Mode } from "@shared/storage/types"
import * as reasoningSupport from "@shared/utils/reasoningSupport"

export function supportsReasoningEffortForModelId(modelId?: string, _allowShortOpenAiIds = false): boolean {
	return reasoningSupport.supportsReasoningEffortForModel(modelId)
}

/**
 * Returns the static model list for a provider.
 * For providers with dynamic models (openrouter, cline, ollama, etc.), returns undefined.
 * Some providers depend on configuration (qwen, zai) for region-specific models.
 */
export function getModelsForProvider(
	provider: ApiProvider,
	apiConfiguration?: ApiConfiguration,
	dynamicModels: { liteLlmModels?: Record<string, ModelInfo>; basetenModels?: Record<string, ModelInfo> } = {},
): Record<string, ModelInfo> | undefined {
	switch (provider) {
		case "anthropic":
			return anthropicModels
		case "claude-code":
			return claudeCodeModels
		case "bedrock":
			return bedrockModels
		case "vertex":
			return vertexModels
		case "gemini":
			return geminiModels
		case "openai-native":
			return openAiNativeModels
		case "openai-codex":
			return openAiCodexModels
		case "deepseek":
			return deepSeekModels
		case "qwen":
			return apiConfiguration?.qwenApiLine === "china" ? mainlandQwenModels : internationalQwenModels
		case "qwen-code":
			return qwenCodeModels
		case "doubao":
			return doubaoModels
		case "mistral":
			return mistralModels
		case "asksage":
			return askSageModels
		case "xai":
			return xaiModels
		case "moonshot":
			return moonshotModels
		case "nebius":
			return nebiusModels
		case "wandb":
			return wandbModels
		case "sambanova":
			return sambanovaModels
		case "cerebras":
			return cerebrasModels
		case "groq":
			return groqModels
		case "baseten":
			return dynamicModels?.basetenModels || basetenModels
		case "sapaicore":
			return sapAiCoreModels
		case "huawei-cloud-maas":
			return huaweiCloudMaasModels
		case "zai":
			return apiConfiguration?.zaiApiLine === "china" ? mainlandZAiModels : internationalZAiModels
		case "fireworks":
			return fireworksModels
		case "minimax":
			return minimaxModels
		case "huggingface":
			return huggingFaceModels
		case "nousResearch":
			return nousResearchModels
		case "litellm":
			return dynamicModels?.liteLlmModels
		// Providers with dynamic models - return undefined
		case "openrouter":
		case "cline":
		case "openai":
		case "ollama":
		case "lmstudio":
		case "vscode-lm":
		case "requesty":
		case "hicap":
		case "dify":
		case "vercel-ai-gateway":
		case "oca":
		case "aihubmix":
		case "together":
		default:
			return undefined
	}
}
