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

export interface NormalizedApiConfig {
	selectedProvider: ApiProvider
	selectedModelId: string
	selectedModelInfo: ModelInfo
}

/**
 * Normalizes API configuration to ensure consistent values
 */
export function normalizeApiConfiguration(
	apiConfiguration: ApiConfiguration | undefined,
	currentMode: Mode,
): NormalizedApiConfig {
	const provider =
		(currentMode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider) || "anthropic"

	const modelId = currentMode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId

	const getProviderData = (models: Record<string, ModelInfo>, defaultId: string) => {
		let selectedModelId: string
		let selectedModelInfo: ModelInfo
		if (modelId && modelId in models) {
			selectedModelId = modelId
			selectedModelInfo = models[modelId]
		} else {
			selectedModelId = defaultId
			selectedModelInfo = models[defaultId]
		}
		return {
			selectedProvider: provider,
			selectedModelId,
			selectedModelInfo,
		}
	}

	switch (provider) {
		case "anthropic":
			return getProviderData(anthropicModels, anthropicDefaultModelId)
		case "claude-code":
			return getProviderData(claudeCodeModels, claudeCodeDefaultModelId)
		case "bedrock":
			const awsBedrockCustomSelected =
				currentMode === "plan"
					? apiConfiguration?.planModeAwsBedrockCustomSelected
					: apiConfiguration?.actModeAwsBedrockCustomSelected
			if (awsBedrockCustomSelected) {
				const baseModelId =
					currentMode === "plan"
						? apiConfiguration?.planModeAwsBedrockCustomModelBaseId
						: apiConfiguration?.actModeAwsBedrockCustomModelBaseId

				return {
					selectedProvider: provider,
					selectedModelId: modelId || bedrockDefaultModelId,
					selectedModelInfo:
						(baseModelId && bedrockModels[baseModelId as keyof typeof bedrockModels]) ||
						bedrockModels[bedrockDefaultModelId],
				}
			}
			return getProviderData(bedrockModels, bedrockDefaultModelId)
		case "vertex":
			return getProviderData(vertexModels, vertexDefaultModelId)
		case "gemini":
			return getProviderData(geminiModels, geminiDefaultModelId)
		case "openai-native":
			return getProviderData(openAiNativeModels, openAiNativeDefaultModelId)
		case "openai-codex":
			return getProviderData(openAiCodexModels, openAiCodexDefaultModelId)
		case "deepseek":
			return getProviderData(deepSeekModels, deepSeekDefaultModelId)
		case "qwen":
			const qwenModels = apiConfiguration?.qwenApiLine === "china" ? mainlandQwenModels : internationalQwenModels
			const qwenDefaultId =
				apiConfiguration?.qwenApiLine === "china" ? mainlandQwenDefaultModelId : internationalQwenDefaultModelId
			return getProviderData(qwenModels, qwenDefaultId)
		case "qwen-code":
			return getProviderData(qwenCodeModels, qwenCodeDefaultModelId)
		case "doubao":
			return getProviderData(doubaoModels, doubaoDefaultModelId)
		case "mistral":
			return getProviderData(mistralModels, mistralDefaultModelId)
		case "asksage":
			return getProviderData(askSageModels, askSageDefaultModelId)
		case "openrouter":
			const openRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const openRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: apiConfiguration?.actModeOpenRouterModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openRouterModelId || openRouterDefaultModelId,
				selectedModelInfo: openRouterModelInfo || openRouterDefaultModelInfo,
			}
		case "requesty":
			const requestyModelId =
				currentMode === "plan" ? apiConfiguration?.planModeRequestyModelId : apiConfiguration?.actModeRequestyModelId
			const requestyModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeRequestyModelInfo : apiConfiguration?.actModeRequestyModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: requestyModelId || requestyDefaultModelId,
				selectedModelInfo: requestyModelInfo || requestyDefaultModelInfo,
			}
		case "cline":
			const fallbackOpenRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const fallbackOpenRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: apiConfiguration?.actModeOpenRouterModelInfo
			const clineModelId =
				(currentMode === "plan" ? apiConfiguration?.planModeClineModelId : apiConfiguration?.actModeClineModelId) ||
				fallbackOpenRouterModelId ||
				openRouterDefaultModelId
			const clineModelInfo =
				(currentMode === "plan" ? apiConfiguration?.planModeClineModelInfo : apiConfiguration?.actModeClineModelInfo) ||
				fallbackOpenRouterModelInfo ||
				openRouterDefaultModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: clineModelId,
				selectedModelInfo: clineModelInfo,
			}
		case "openai":
			const openAiModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelId : apiConfiguration?.actModeOpenAiModelId
			const openAiModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelInfo : apiConfiguration?.actModeOpenAiModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openAiModelId || "",
				selectedModelInfo: openAiModelInfo || openAiModelInfoSaneDefaults,
			}
		case "hicap":
			const hicapModelId =
				currentMode === "plan" ? apiConfiguration?.planModeHicapModelId : apiConfiguration?.actModeHicapModelId
			return {
				selectedProvider: provider,
				selectedModelId: hicapModelId || "",
				selectedModelInfo: hicapModelInfoSaneDefaults,
			}
		case "ollama":
			const ollamaModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOllamaModelId : apiConfiguration?.actModeOllamaModelId
			return {
				selectedProvider: provider,
				selectedModelId: ollamaModelId || "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					contextWindow: Number(apiConfiguration?.ollamaApiOptionsCtxNum ?? 32768),
					supportsImages: inferLocalModelImageSupport(ollamaModelId || ""),
				},
			}
		case "lmstudio":
			const lmStudioModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLmStudioModelId : apiConfiguration?.actModeLmStudioModelId
			return {
				selectedProvider: provider,
				selectedModelId: lmStudioModelId || "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					contextWindow: Number(apiConfiguration?.lmStudioMaxTokens ?? 32768),
				},
			}
		case "vscode-lm":
			const vsCodeLmModelSelector =
				currentMode === "plan"
					? apiConfiguration?.planModeVsCodeLmModelSelector
					: apiConfiguration?.actModeVsCodeLmModelSelector
			return {
				selectedProvider: provider,
				selectedModelId: vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor}/${vsCodeLmModelSelector.family}` : "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					supportsImages: false, // VSCode LM API currently doesn't support images
				},
			}
		case "litellm": {
			const liteLlmModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelId : apiConfiguration?.actModeLiteLlmModelId
			const liteLlmModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelInfo : apiConfiguration?.actModeLiteLlmModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: liteLlmModelId || "",
				selectedModelInfo: liteLlmModelInfo || liteLlmModelInfoSaneDefaults,
			}
		}
		case "xai":
			return getProviderData(xaiModels, xaiDefaultModelId)
		case "moonshot":
			return getProviderData(moonshotModels, moonshotDefaultModelId)
		case "huggingface":
			const huggingFaceModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeHuggingFaceModelId
					: apiConfiguration?.actModeHuggingFaceModelId
			const huggingFaceModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeHuggingFaceModelInfo
					: apiConfiguration?.actModeHuggingFaceModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: huggingFaceModelId || huggingFaceDefaultModelId,
				selectedModelInfo: huggingFaceModelInfo || huggingFaceModels[huggingFaceDefaultModelId],
			}
		case "nebius":
			return getProviderData(nebiusModels, nebiusDefaultModelId)
		case "wandb":
			return getProviderData(wandbModels, wandbDefaultModelId)
		case "sambanova":
			return getProviderData(sambanovaModels, sambanovaDefaultModelId)
		case "cerebras":
			return getProviderData(cerebrasModels, cerebrasDefaultModelId)
		case "groq":
			const groqModelId =
				currentMode === "plan" ? apiConfiguration?.planModeGroqModelId : apiConfiguration?.actModeGroqModelId
			const groqModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeGroqModelInfo : apiConfiguration?.actModeGroqModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: groqModelId || groqDefaultModelId,
				selectedModelInfo: groqModelInfo || groqModels[groqDefaultModelId],
			}
		case "baseten": {
			const basetenModelId =
				currentMode === "plan" ? apiConfiguration?.planModeBasetenModelId : apiConfiguration?.actModeBasetenModelId
			const basetenModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeBasetenModelInfo : apiConfiguration?.actModeBasetenModelInfo
			const finalBasetenModelId = basetenModelId || basetenDefaultModelId
			return {
				selectedProvider: provider,
				selectedModelId: finalBasetenModelId,
				selectedModelInfo: basetenModelInfo ||
					basetenModels[finalBasetenModelId as keyof typeof basetenModels] ||
					basetenModels[basetenDefaultModelId] || {
						description: "Baseten model",
						supportsPromptCache: false,
					},
			}
		}
		case "sapaicore":
			return getProviderData(sapAiCoreModels, sapAiCoreDefaultModelId)
		case "huawei-cloud-maas":
			const huaweiCloudMaasModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeHuaweiCloudMaasModelId
					: apiConfiguration?.actModeHuaweiCloudMaasModelId
			const huaweiCloudMaasModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeHuaweiCloudMaasModelInfo
					: apiConfiguration?.actModeHuaweiCloudMaasModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: huaweiCloudMaasModelId || huaweiCloudMaasDefaultModelId,
				selectedModelInfo: huaweiCloudMaasModelInfo || huaweiCloudMaasModels[huaweiCloudMaasDefaultModelId],
			}
		case "dify":
			return {
				selectedProvider: provider,
				selectedModelId: "dify-workflow",
				selectedModelInfo: {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsImages: true,
					supportsPromptCache: false,
					inputPrice: 0,
					outputPrice: 0,
					description: "Dify workflow - model selection is configured in your Dify application",
				},
			}
		case "vercel-ai-gateway":
			// Vercel AI Gateway uses its own model fields
			const vercelModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeVercelAiGatewayModelId
					: apiConfiguration?.actModeVercelAiGatewayModelId
			const vercelModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeVercelAiGatewayModelInfo
					: apiConfiguration?.actModeVercelAiGatewayModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: vercelModelId || "",
				selectedModelInfo: vercelModelInfo || openRouterDefaultModelInfo,
			}
		case "zai":
			const zaiModels = apiConfiguration?.zaiApiLine === "china" ? mainlandZAiModels : internationalZAiModels
			const zaiDefaultId =
				apiConfiguration?.zaiApiLine === "china" ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId
			return getProviderData(zaiModels, zaiDefaultId)
		case "fireworks":
			const fireworksModelId =
				currentMode === "plan" ? apiConfiguration?.planModeFireworksModelId : apiConfiguration?.actModeFireworksModelId
			return {
				selectedProvider: provider,
				selectedModelId: fireworksModelId || fireworksDefaultModelId,
				selectedModelInfo:
					fireworksModelId && fireworksModelId in fireworksModels
						? fireworksModels[fireworksModelId as keyof typeof fireworksModels]
						: fireworksModels[fireworksDefaultModelId],
			}
		case "oca":
			const ocaModelId = currentMode === "plan" ? apiConfiguration?.planModeOcaModelId : apiConfiguration?.actModeOcaModelId
			const ocaModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeOcaModelInfo : apiConfiguration?.actModeOcaModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: ocaModelId || "",
				selectedModelInfo: ocaModelInfo || liteLlmModelInfoSaneDefaults,
			}
		case "aihubmix":
			const aihubmixModelId =
				currentMode === "plan" ? apiConfiguration?.planModeAihubmixModelId : apiConfiguration?.actModeAihubmixModelId
			const aihubmixModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeAihubmixModelInfo : apiConfiguration?.actModeAihubmixModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: aihubmixModelId || "",
				selectedModelInfo: aihubmixModelInfo || openAiModelInfoSaneDefaults,
			}
		case "minimax":
			return getProviderData(minimaxModels, minimaxDefaultModelId)
		case "nousResearch":
			const nousResearchModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeNousResearchModelId
					: apiConfiguration?.actModeNousResearchModelId
			return {
				selectedProvider: provider,
				selectedModelId: nousResearchModelId || nousResearchDefaultModelId,
				selectedModelInfo:
					nousResearchModelId && nousResearchModelId in nousResearchModels
						? nousResearchModels[nousResearchModelId as keyof typeof nousResearchModels]
						: nousResearchModels[nousResearchDefaultModelId],
			}
		default:
			return getProviderData(anthropicModels, anthropicDefaultModelId)
	}
}

export function inferLocalModelImageSupport(modelId: string) {
	const id = modelId.toLowerCase()
	return /(claude|gemini|gpt-4o|gpt-4\.1|vision|llava|bakllava|moondream|pixtral|qwen[^/]*[-_.:]?vl|gemma[-_.:]?3|ministral[-_.:]?3|phi[^/]*vision)/.test(id)
}
