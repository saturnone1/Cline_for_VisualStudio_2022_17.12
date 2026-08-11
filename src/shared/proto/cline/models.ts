import { createProtoStub } from "../protoStub"
import type { ApiConfiguration } from "../../api"

const apiProviderNames = [
	"AIHUBMIX", "ANTHROPIC", "ASKSAGE", "BASETEN", "BEDROCK", "CEREBRAS", "CLAUDE_CODE", "CLINE",
	"DEEPSEEK", "DIFY", "DOUBAO", "FIREWORKS", "GEMINI", "GROQ", "HICAP", "HUAWEI_CLOUD_MAAS",
	"HUGGINGFACE", "LITELLM", "LMSTUDIO", "MINIMAX", "MISTRAL", "MOONSHOT", "NEBIUS", "NOUSRESEARCH",
	"OCA", "OLLAMA", "OPENAI", "OPENAI_CODEX", "OPENAI_NATIVE", "OPENROUTER", "QWEN", "QWEN_CODE",
	"REQUESTY", "SAMBANOVA", "SAPAICORE", "TOGETHER", "VERCEL_AI_GATEWAY", "VERTEX", "VSCODE_LM",
	"WANDB", "XAI", "ZAI",
] as const

export type ApiProvider = (typeof apiProviderNames)[number]
export const ApiProvider = Object.fromEntries(apiProviderNames.map((name) => [name, name])) as Record<ApiProvider, ApiProvider>

export type ApiFormat = "OPENAI_RESPONSES" | "OPENAI_RESPONSES_WEBSOCKET_MODE"
export const ApiFormat = {
	OPENAI_RESPONSES: "OPENAI_RESPONSES",
	OPENAI_RESPONSES_WEBSOCKET_MODE: "OPENAI_RESPONSES_WEBSOCKET_MODE",
} as const satisfies Record<string, ApiFormat>

export type ClineRecommendedModel = { id: string; name: string; description: string; tags: string[] }
export const ClineRecommendedModel = createProtoStub<ClineRecommendedModel>("ClineRecommendedModel")

export type ClineRecommendedModelsResponse = { recommended: ClineRecommendedModel[]; free: ClineRecommendedModel[] }
export const ClineRecommendedModelsResponse = createProtoStub<ClineRecommendedModelsResponse>("ClineRecommendedModelsResponse")

export type LanguageModelChatSelector = { vendor: string; family: string; version: string; id: string }
export const LanguageModelChatSelector = createProtoStub<LanguageModelChatSelector>("LanguageModelChatSelector")

export type PriceTier = { tokenLimit: number; price: number }
export type ModelTier = {
	contextWindow: number
	inputPrice?: number
	outputPrice?: number
	cacheWritesPrice?: number
	cacheReadsPrice?: number
}

export type ThinkingConfig = { maxBudget?: number; outputPrice?: number; outputPriceTiers: PriceTier[] }
export const ThinkingConfig = createProtoStub<ThinkingConfig>("ThinkingConfig")

export type OpenRouterModelInfo = {
	name?: string
	maxTokens?: number
	contextWindow?: number
	supportsImages?: boolean
	supportsPromptCache: boolean
	supportsReasoning?: boolean
	inputPrice?: number
	outputPrice?: number
	cacheWritesPrice?: number
	cacheReadsPrice?: number
	description?: string
	thinkingConfig?: ThinkingConfig
	supportsGlobalEndpoint?: boolean
	tiers: ModelTier[]
}
export const OpenRouterModelInfo = createProtoStub<OpenRouterModelInfo>("OpenRouterModelInfo")

export type OpenAiCompatibleModelInfo = OpenRouterModelInfo & { temperature?: number; isR1FormatRequired?: boolean }
export const OpenAiCompatibleModelInfo = createProtoStub<OpenAiCompatibleModelInfo>("OpenAiCompatibleModelInfo")

export type LiteLLMModelInfo = OpenRouterModelInfo & { temperature?: number }
export const LiteLLMModelInfo = createProtoStub<LiteLLMModelInfo>("LiteLLMModelInfo")

export type OcaModelInfo = Omit<OpenRouterModelInfo, "tiers"> & {
	temperature?: number
	modelName: string
	surveyId?: string
	banner?: string
	surveyContent?: string
	apiFormat?: ApiFormat
	reasoningEffortOptions?: string[]
}
export const OcaModelInfo = createProtoStub<OcaModelInfo>("OcaModelInfo")

export type OpenRouterCompatibleModelInfo = { models: Record<string, OpenRouterModelInfo> }
export const OpenRouterCompatibleModelInfo = createProtoStub<OpenRouterCompatibleModelInfo>("OpenRouterCompatibleModelInfo")

export type OpenAiModelsRequest = { baseUrl: string; apiKey: string }
export const OpenAiModelsRequest = createProtoStub<OpenAiModelsRequest>("OpenAiModelsRequest")

type StandardModelInfoKey =
	| "planModeOpenRouterModelInfo" | "planModeClineModelInfo" | "planModeRequestyModelInfo" | "planModeGroqModelInfo"
	| "planModeBasetenModelInfo" | "planModeHuggingFaceModelInfo" | "planModeHuaweiCloudMaasModelInfo"
	| "planModeHicapModelInfo" | "planModeVercelAiGatewayModelInfo"
	| "actModeOpenRouterModelInfo" | "actModeClineModelInfo" | "actModeRequestyModelInfo" | "actModeGroqModelInfo"
	| "actModeBasetenModelInfo" | "actModeHuggingFaceModelInfo" | "actModeHuaweiCloudMaasModelInfo"
	| "actModeHicapModelInfo" | "actModeVercelAiGatewayModelInfo"
type OpenAiModelInfoKey = "planModeOpenAiModelInfo" | "planModeAihubmixModelInfo" | "actModeOpenAiModelInfo" | "actModeAihubmixModelInfo"
type LiteLlmModelInfoKey = "planModeLiteLlmModelInfo" | "actModeLiteLlmModelInfo"
type OcaModelInfoKey = "planModeOcaModelInfo" | "actModeOcaModelInfo"
type TransportOverrideKey =
	| "planModeApiProvider" | "actModeApiProvider" | StandardModelInfoKey | OpenAiModelInfoKey | LiteLlmModelInfoKey | OcaModelInfoKey

export type ModelsApiConfiguration = Omit<ApiConfiguration, TransportOverrideKey> & {
	planModeApiProvider?: ApiProvider
	actModeApiProvider?: ApiProvider
} & Partial<Record<StandardModelInfoKey, OpenRouterModelInfo>>
	& Partial<Record<OpenAiModelInfoKey, OpenAiCompatibleModelInfo>>
	& Partial<Record<LiteLlmModelInfoKey, LiteLLMModelInfo>>
	& Partial<Record<OcaModelInfoKey, OcaModelInfo>>
export const ModelsApiConfiguration = createProtoStub<ModelsApiConfiguration>("ModelsApiConfiguration")

export type UpdateApiConfigurationRequest = { apiConfiguration: ModelsApiConfiguration }
export const UpdateApiConfigurationRequest = createProtoStub<UpdateApiConfigurationRequest>("UpdateApiConfigurationRequest")
