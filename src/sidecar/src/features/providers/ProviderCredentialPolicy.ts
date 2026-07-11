import { normalizeProviderValue, normalizeSdkProviderId, oauthCredentialsField, providerAuthLabel } from "../../application/services/ProviderIdentity"

const credentialFields: Readonly<Record<string, readonly string[]>> = {
	cline: ["clineApiKey", "clineAccountId"], anthropic: ["apiKey"], openrouter: ["openRouterApiKey"], bedrock: ["awsBedrockApiKey", "awsAccessKey"], openai: ["openAiApiKey"], "openai-compatible": ["openAiApiKey"], "openai-native": ["openAiNativeApiKey"], ollama: ["ollamaApiKey"], gemini: ["geminiApiKey"], requesty: ["requestyApiKey"], together: ["togetherApiKey"], fireworks: ["fireworksApiKey"], groq: ["groqApiKey"], litellm: ["liteLlmApiKey"], moonshot: ["moonshotApiKey"], nebius: ["nebiusApiKey"], deepseek: ["deepSeekApiKey"], qwen: ["qwenApiKey"], "qwen-code": ["qwenApiKey"], doubao: ["doubaoApiKey"], mistral: ["mistralApiKey"], xai: ["xaiApiKey"], zai: ["zaiApiKey"], sambanova: ["sambanovaApiKey"], cerebras: ["cerebrasApiKey"], asksage: ["asksageApiKey"], baseten: ["basetenApiKey"], huggingface: ["huggingFaceApiKey"], "huawei-cloud-maas": ["huaweiCloudMaasApiKey"], dify: ["difyApiKey"], "vercel-ai-gateway": ["vercelAiGatewayApiKey"], minimax: ["minimaxApiKey"], aihubmix: ["aihubmixApiKey"], hicap: ["hicapApiKey"], nousResearch: ["nousResearchApiKey"], sapaicore: ["sapAiCoreClientId", "sapAiCoreClientSecret"], oca: ["ocaApiKey"], wandb: ["wandbApiKey"],
}

const baseUrlFields: Readonly<Record<string, string>> = {
	anthropic: "anthropicBaseUrl", bedrock: "awsBedrockEndpoint", openai: "openAiBaseUrl", "openai-compatible": "openAiBaseUrl", "openai-native": "openAiBaseUrl", openrouter: "openRouterBaseUrl", groq: "groqBaseUrl", gemini: "geminiBaseUrl", ollama: "ollamaBaseUrl", lmstudio: "lmStudioBaseUrl", litellm: "liteLlmBaseUrl", requesty: "requestyBaseUrl", huggingface: "huggingFaceBaseUrl", baseten: "basetenBaseUrl", "vercel-ai-gateway": "vercelAiGatewayBaseUrl", hicap: "hicapBaseUrl", asksage: "asksageApiUrl", sapaicore: "sapAiCoreBaseUrl", dify: "difyBaseUrl", oca: "ocaBaseUrl", aihubmix: "aihubmixBaseUrl",
}

export function providerCredentialFields(providerId: string) { return [...(credentialFields[providerId] || [])] }
export function providerCredentialField(providerId: string) { return providerCredentialFields(providerId)[0] || "" }
export function providerBaseUrlField(providerId: string) { return baseUrlFields[providerId] || "" }
export function extractProviderCredentialValue(request: Record<string, unknown>) { return ["apiKey", "token", "accessToken", "credential", "secret", "value"].map((key) => readString(request[key])).find(Boolean) || "" }

export function resolveOAuthCredentials(apiConfig: Record<string, unknown>, providerId: string) {
	const raw = readString(apiConfig[oauthCredentialsField(providerId)])
	if (!raw) return {}
	try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { accessToken: raw } } catch { return { accessToken: raw } }
}

export function describeOAuthCredentialState(credentials: Record<string, unknown>, now = Date.now(), expirySkewMs = 60_000) {
	const expiresAt = readNumber(credentials.expiresAt) || readNumber(credentials.expires_at)
	const refreshToken = readString(credentials.refreshToken) || readString(credentials.refresh_token)
	if (!Object.keys(credentials).length) return { refreshStatus: "none", refreshSupported: false, expiresAt: undefined }
	if (!expiresAt) return { refreshStatus: refreshToken ? "refreshable" : "unknown", refreshSupported: Boolean(refreshToken), expiresAt: undefined }
	return { refreshStatus: expiresAt <= now + expirySkewMs ? "expired" : refreshToken ? "refreshable" : "valid", refreshSupported: Boolean(refreshToken), expiresAt }
}

export function isOAuthBridgeProvider(provider: string) {
	const normalized = normalizeProviderValue(provider)
	const compact = provider.replace(/[_\s-]/g, "").toLowerCase()
	return normalized === "oca" || normalized === "openai-codex" || normalized === "account" || compact === "openaicodex"
}

export function createFallbackProviderConfigFields(provider: string) {
	const providerId = normalizeSdkProviderId(provider)
	if (isOAuthBridgeProvider(provider)) return { providerId, authMethod: "oauth", fields: {}, description: `${providerAuthLabel(provider)} requires a Visual Studio-compatible OAuth callback/token exchange bridge.` }
	const fields: Record<string, Record<string, unknown>> = providerCredentialField(provider) ? { apiKey: { label: `${providerAuthLabel(provider)} API Key`, placeholder: "Enter API Key..." } } : {}
	const baseUrlField = providerBaseUrlField(provider)
	if (baseUrlField) fields.baseUrl = { label: "Base URL", placeholder: "https://...", optional: true }
	return { providerId, authMethod: Object.keys(fields).length ? "api-key" : "local", fields, description: `${providerAuthLabel(provider)} provider metadata is using the LIG VS fallback map.` }
}

function readString(value: unknown) { return typeof value === "string" ? value : "" }
function readNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
