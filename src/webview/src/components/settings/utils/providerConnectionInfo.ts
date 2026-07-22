import type { ApiProvider } from "@shared/api"

export const getProviderInfo = (
	provider: ApiProvider,
	apiConfiguration: any,
	effectiveMode: "plan" | "act",
): { modelId?: string; baseUrl?: string; helpText: string } => {
	switch (provider) {
		case "baseten":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeBasetenModelId : apiConfiguration.actModeBasetenModelId,
				baseUrl: apiConfiguration.basetenBaseUrl,
				helpText: "Start Baseten and load a model to begin",
			}
		case "lmstudio":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLmStudioModelId : apiConfiguration.actModeLmStudioModelId,
				baseUrl: apiConfiguration.lmStudioBaseUrl,
				helpText: "Start LM Studio and load a model to begin",
			}
		case "ollama":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeOllamaModelId : apiConfiguration.actModeOllamaModelId,
				baseUrl: apiConfiguration.ollamaBaseUrl,
				helpText: "Run `ollama serve` and pull a model",
			}
		case "litellm":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLiteLlmModelId : apiConfiguration.actModeLiteLlmModelId,
				baseUrl: apiConfiguration.liteLlmBaseUrl,
				helpText: "Add your LiteLLM proxy URL in settings",
			}
		case "openai":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeOpenAiModelId : apiConfiguration.actModeOpenAiModelId,
				baseUrl: apiConfiguration.openAiBaseUrl,
				helpText: "Add your OpenAI API key and endpoint",
			}
		case "vscode-lm":
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Select a VS Code language model from settings",
			}
		case "requesty":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeRequestyModelId : apiConfiguration.actModeRequestyModelId,
				baseUrl: apiConfiguration.requestyBaseUrl,
				helpText: "Add your Requesty API key in settings",
			}
		case "together":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeTogetherModelId : apiConfiguration.actModeTogetherModelId,
				baseUrl: undefined,
				helpText: "Add your Together AI API key in settings",
			}
		case "dify":
			return {
				modelId: undefined,
				baseUrl: apiConfiguration.difyBaseUrl,
				helpText: "Configure your Dify workflow URL and API key",
			}
		case "hicap":
			return {
				modelId: effectiveMode === "plan" ? apiConfiguration.planModeHicapModelId : apiConfiguration.actModeHicapModelId,
				baseUrl: undefined,
				helpText: "Add your HiCap API key in settings",
			}
		case "oca":
			return {
				modelId: effectiveMode === "plan" ? apiConfiguration.planModeOcaModelId : apiConfiguration.actModeOcaModelId,
				baseUrl: apiConfiguration.ocaBaseUrl,
				helpText: "Configure your OCA endpoint in settings",
			}
		case "aihubmix":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeAihubmixModelId : apiConfiguration.actModeAihubmixModelId,
				baseUrl: apiConfiguration.aihubmixBaseUrl,
				helpText: "Add your AIHubMix API key in settings",
			}
		default:
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Configure this provider in model settings",
			}
	}
}
