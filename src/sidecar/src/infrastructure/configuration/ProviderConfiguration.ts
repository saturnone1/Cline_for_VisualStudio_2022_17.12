import { mapToolName, normalizeMcpDisplayMode } from "../conversation/ConversationSupport"
import { inferModelInfo } from "../models/ModelCatalog"
import { normalizeProviderId, normalizeProviderValue, normalizeSdkProviderId, oauthCredentialsField, providerAuthLabel } from "../../application/services/ProviderIdentity"

export type OAuthTokenExchangeConfig = { tokenUrl: string; clientId: string; clientSecret?: string; scope?: string; codeVerifier?: string; authMethod?: string }

export function compactApiConfiguration(apiConfig: Record<string, unknown>) {
	const compact: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(apiConfig)) {
		if (value !== undefined && value !== null) {
			compact[key] = value
		}
	}

	for (const key of ["actModeApiProvider", "planModeApiProvider"]) {
		const value = compact[key]
		const normalized = normalizeProviderValue(value)
		if (normalized) {
			compact[key] = normalized
		}
	}

	return compact
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

	const providerSpecific = getString(apiConfig, providerModelFields[providerId])
	if (providerSpecific) {
		return providerSpecific
	}

	if (providerId === "ollama") {
		return ""
	}

	return getString(apiConfig, `${modePrefix}ApiModelId`) || getString(apiConfig, `${modePrefix}OpenAiModelId`)
}

export function resolveConfiguredContextWindow(
	apiConfig: Record<string, unknown>,
	providerId: string,
	modePrefix: string,
	modelId: string,
) {
	const providerInfoFields: Record<string, string> = {
		openrouter: `${modePrefix}OpenRouterModelInfo`,
		openai: `${modePrefix}OpenAiModelInfo`,
		"openai-compatible": `${modePrefix}OpenAiModelInfo`,
		aihubmix: `${modePrefix}AihubmixModelInfo`,
		anthropic: `${modePrefix}ApiModelInfo`,
	}
	const explicitModelInfo = asRecord(apiConfig[providerInfoFields[providerId] || `${modePrefix}ApiModelInfo`])
	const explicitContextWindow = positiveIntegerValue(explicitModelInfo.contextWindow) ?? positiveIntegerValue(explicitModelInfo.context_length)
	if (explicitContextWindow && explicitContextWindow > 0) {
		return explicitContextWindow
	}
	if (providerId === "ollama") {
		return positiveIntegerValue(apiConfig.ollamaApiOptionsCtxNum) || positiveIntegerValue(inferModelInfo(modelId, providerId).contextWindow)
	}
	if (providerId === "lmstudio") {
		return positiveIntegerValue(apiConfig.lmStudioMaxTokens) || positiveIntegerValue(inferModelInfo(modelId, providerId).contextWindow)
	}
	return positiveIntegerValue(inferModelInfo(modelId, providerId).contextWindow)
}

export function positiveIntegerValue(value: unknown) {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined
}

export function resolveApiKey(apiConfig: Record<string, unknown>, providerId: string) {
	for (const field of providerCredentialFields(providerId)) {
		const value = getString(apiConfig, field)
		if (value) {
			return value
		}
	}

	return (
		resolveProviderEnvApiKey(providerId) ||
		(["openai", "openai-compatible", "openai-native"].includes(providerId)
			? getString(apiConfig, "actModeOpenAiApiKey") || getString(apiConfig, "planModeOpenAiApiKey")
			: "")
	)
}

export function providerCredentialFields(providerId: string) {
	const apiKeyFields: Record<string, string[]> = {
		cline: ["clineApiKey", "clineAccountId"],
		anthropic: ["apiKey"],
		openrouter: ["openRouterApiKey"],
		bedrock: ["awsBedrockApiKey", "awsAccessKey"],
		openai: ["openAiApiKey"],
		"openai-compatible": ["openAiApiKey"],
		"openai-native": ["openAiNativeApiKey"],
		ollama: ["ollamaApiKey"],
		gemini: ["geminiApiKey"],
		requesty: ["requestyApiKey"],
		together: ["togetherApiKey"],
		fireworks: ["fireworksApiKey"],
		groq: ["groqApiKey"],
		litellm: ["liteLlmApiKey"],
		moonshot: ["moonshotApiKey"],
		nebius: ["nebiusApiKey"],
		deepseek: ["deepSeekApiKey"],
		qwen: ["qwenApiKey"],
		"qwen-code": ["qwenApiKey"],
		doubao: ["doubaoApiKey"],
		mistral: ["mistralApiKey"],
		xai: ["xaiApiKey"],
		zai: ["zaiApiKey"],
		sambanova: ["sambanovaApiKey"],
		cerebras: ["cerebrasApiKey"],
		asksage: ["asksageApiKey"],
		baseten: ["basetenApiKey"],
		huggingface: ["huggingFaceApiKey"],
		"huawei-cloud-maas": ["huaweiCloudMaasApiKey"],
		dify: ["difyApiKey"],
		"vercel-ai-gateway": ["vercelAiGatewayApiKey"],
		minimax: ["minimaxApiKey"],
		aihubmix: ["aihubmixApiKey"],
		hicap: ["hicapApiKey"],
		nousResearch: ["nousResearchApiKey"],
		sapaicore: ["sapAiCoreClientId", "sapAiCoreClientSecret"],
		oca: ["ocaApiKey"],
		wandb: ["wandbApiKey"],
	}
	return apiKeyFields[providerId] || []
}

export function providerCredentialField(providerId: string) {
	return providerCredentialFields(providerId)[0] || ""
}

export function extractProviderCredentialValue(request: Record<string, unknown>) {
	return (
		getString(request, "apiKey") ||
		getString(request, "token") ||
		getString(request, "accessToken") ||
		getString(request, "credential") ||
		getString(request, "secret") ||
		getString(request, "value")
	)
}

export function providerBaseUrlField(providerId: string) {
	const baseUrlFields: Record<string, string> = {
		anthropic: "anthropicBaseUrl",
		bedrock: "awsBedrockEndpoint",
		openai: "openAiBaseUrl",
		"openai-compatible": "openAiBaseUrl",
		"openai-native": "openAiBaseUrl",
		openrouter: "openRouterBaseUrl",
		groq: "groqBaseUrl",
		gemini: "geminiBaseUrl",
		ollama: "ollamaBaseUrl",
		lmstudio: "lmStudioBaseUrl",
		litellm: "liteLlmBaseUrl",
		requesty: "requestyBaseUrl",
		huggingface: "huggingFaceBaseUrl",
		baseten: "basetenBaseUrl",
		"vercel-ai-gateway": "vercelAiGatewayBaseUrl",
		hicap: "hicapBaseUrl",
		asksage: "asksageApiUrl",
		sapaicore: "sapAiCoreBaseUrl",
		dify: "difyBaseUrl",
		oca: "ocaBaseUrl",
		aihubmix: "aihubmixBaseUrl",
	}

	return baseUrlFields[providerId] || ""
}

export function resolveBaseUrl(apiConfig: Record<string, unknown>, providerId: string) {
	const field = providerBaseUrlField(providerId)
	const providerSpecific = (field ? getString(apiConfig, field) : "") || resolveProviderEnvBaseUrl(providerId)
	if (providerSpecific) {
		return providerSpecific
	}
	return ["openai", "openai-compatible", "openai-native"].includes(providerId) ? getString(apiConfig, "actModeOpenAiBaseUrl") : ""
}

export function resolveProviderEnvApiKey(providerId: string) {
	const envFields: Record<string, string[]> = {
		cline: ["CLINE_API_KEY"],
		anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
		openrouter: ["OPENROUTER_API_KEY"],
		openai: ["OPENAI_API_KEY"],
		"openai-compatible": ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
		"openai-native": ["OPENAI_API_KEY"],
		ollama: ["OLLAMA_API_KEY"],
		gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
		requesty: ["REQUESTY_API_KEY"],
		together: ["TOGETHER_API_KEY"],
		fireworks: ["FIREWORKS_API_KEY"],
		groq: ["GROQ_API_KEY"],
		litellm: ["LITELLM_API_KEY", "LITE_LLM_API_KEY"],
		moonshot: ["MOONSHOT_API_KEY"],
		nebius: ["NEBIUS_API_KEY"],
		deepseek: ["DEEPSEEK_API_KEY", "DEEP_SEEK_API_KEY"],
		qwen: ["QWEN_API_KEY"],
		"qwen-code": ["QWEN_API_KEY"],
		doubao: ["DOUBAO_API_KEY"],
		mistral: ["MISTRAL_API_KEY"],
		xai: ["XAI_API_KEY"],
		zai: ["ZAI_API_KEY"],
		sambanova: ["SAMBANOVA_API_KEY"],
		cerebras: ["CEREBRAS_API_KEY"],
		asksage: ["ASKSAGE_API_KEY"],
		baseten: ["BASETEN_API_KEY"],
		huggingface: ["HUGGINGFACE_API_KEY", "HUGGING_FACE_API_KEY"],
		"huawei-cloud-maas": ["HUAWEI_CLOUD_MAAS_API_KEY"],
		dify: ["DIFY_API_KEY"],
		"vercel-ai-gateway": ["VERCEL_AI_GATEWAY_API_KEY"],
		minimax: ["MINIMAX_API_KEY"],
		aihubmix: ["AIHUBMIX_API_KEY"],
		hicap: ["HICAP_API_KEY"],
		nousResearch: ["NOUSRESEARCH_API_KEY", "NOUS_RESEARCH_API_KEY"],
		oca: ["OCA_API_KEY"],
		wandb: ["WANDB_API_KEY"],
	}
	for (const name of envFields[providerId] || []) {
		const value = process.env[name]
		if (value) {
			return value
		}
	}
	return ""
}

export function resolveProviderEnvBaseUrl(providerId: string) {
	const envFields: Record<string, string[]> = {
		anthropic: ["ANTHROPIC_BASE_URL"],
		bedrock: ["AWS_BEDROCK_ENDPOINT"],
		openai: ["OPENAI_BASE_URL"],
		"openai-compatible": ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"],
		"openai-native": ["OPENAI_BASE_URL"],
		openrouter: ["OPENROUTER_BASE_URL"],
		groq: ["GROQ_BASE_URL"],
		gemini: ["GEMINI_BASE_URL"],
		ollama: ["OLLAMA_BASE_URL"],
		lmstudio: ["LMSTUDIO_BASE_URL", "LM_STUDIO_BASE_URL"],
		litellm: ["LITELLM_BASE_URL", "LITE_LLM_BASE_URL"],
		requesty: ["REQUESTY_BASE_URL"],
		huggingface: ["HUGGINGFACE_BASE_URL", "HUGGING_FACE_BASE_URL"],
		baseten: ["BASETEN_BASE_URL"],
		"vercel-ai-gateway": ["VERCEL_AI_GATEWAY_BASE_URL"],
		hicap: ["HICAP_BASE_URL"],
		asksage: ["ASKSAGE_API_URL"],
		sapaicore: ["SAP_AICORE_BASE_URL"],
		dify: ["DIFY_BASE_URL"],
		oca: ["OCA_BASE_URL"],
		aihubmix: ["AIHUBMIX_BASE_URL"],
	}
	for (const name of envFields[providerId] || []) {
		const value = process.env[name]
		if (value) {
			return value
		}
	}
	return ""
}

export function pickApiConfigurationFields(request: Record<string, unknown>) {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(request)) {
		if (
			key === "apiProvider" ||
			key.endsWith("ApiProvider") ||
			key.endsWith("ModelId") ||
			key.endsWith("ApiKey") ||
			key.endsWith("BaseUrl") ||
			key.endsWith("OAuthCredentials") ||
			key.endsWith("ModelInfo") ||
			key.endsWith("ReasoningEffort") ||
			key.endsWith("ThinkingBudgetTokens") ||
			key === "openAiBaseUrl" ||
			key === "anthropicBaseUrl" ||
			key === "geminiBaseUrl" ||
			key === "requestTimeoutMs" ||
			key === "ollamaApiOptionsCtxNum" ||
			key === "lmStudioMaxTokens" ||
			key === "fireworksModelMaxTokens" ||
			key === "fireworksModelMaxCompletionTokens"
		) {
			result[key] = value
		}
	}

	const apiProvider = normalizeProviderValue(result.apiProvider)
	if (apiProvider) {
		result.actModeApiProvider = apiProvider
		result.planModeApiProvider = apiProvider
		delete result.apiProvider
	}

	return result
}

export function extractApiConfigurationUpdate(request: Record<string, unknown>) {
	const direct = [
		request.apiConfiguration,
		request.api_configuration,
		request.configuration,
		request.config,
		request.value,
	]

	for (const candidate of direct) {
		const record = asRecord(candidate)
		const picked = pickApiConfigurationFields(record)
		if (Object.keys(picked).length > 0) {
			return picked
		}
	}

	return pickApiConfigurationFields(request)
}

export function normalizeApiConfiguration(apiConfig: Record<string, unknown>) {
	const normalized = compactApiConfiguration(apiConfig)
	const provider = getString(normalized, "actModeApiProvider") || getString(normalized, "planModeApiProvider")
	if (provider) {
		normalized.actModeApiProvider = provider
		normalized.planModeApiProvider = getString(normalized, "planModeApiProvider") || provider
	}

	const openAiModel = getString(normalized, "openAiModelId")
	if (openAiModel) {
		normalized.actModeOpenAiModelId = getString(normalized, "actModeOpenAiModelId") || openAiModel
		normalized.planModeOpenAiModelId = getString(normalized, "planModeOpenAiModelId") || openAiModel
	}

	const openAiApiKey = getString(normalized, "openAiApiKey")
	if (openAiApiKey) {
		normalized.actModeOpenAiApiKey = getString(normalized, "actModeOpenAiApiKey") || openAiApiKey
		normalized.planModeOpenAiApiKey = getString(normalized, "planModeOpenAiApiKey") || openAiApiKey
	}

	const openAiBaseUrl = getString(normalized, "openAiBaseUrl")
	if (openAiBaseUrl) {
		normalized.actModeOpenAiBaseUrl = getString(normalized, "actModeOpenAiBaseUrl") || openAiBaseUrl
		normalized.planModeOpenAiBaseUrl = getString(normalized, "planModeOpenAiBaseUrl") || openAiBaseUrl
	}

	return normalized
}

export function normalizeApiConfigurationProfiles(
	value: unknown,
	fallbackApiConfiguration: unknown,
	fallbackPlanActSeparateModelsSetting: boolean,
) {
	const now = new Date().toISOString()
	const fallbackProfile = {
		id: "default",
		name: "Default",
		apiConfiguration: normalizeApiConfiguration(asRecord(fallbackApiConfiguration)),
		planActSeparateModelsSetting: fallbackPlanActSeparateModelsSetting,
		createdAt: now,
		updatedAt: now,
	}

	const profiles = arrayOfRecords(value)
		.map((profile, index) => {
			const apiConfiguration = normalizeApiConfiguration(asRecord(profile.apiConfiguration))
			if (Object.keys(apiConfiguration).length === 0) {
				return null
			}
			const id = getString(profile, "id") || `profile-${index + 1}`
			return {
				id,
				name: getString(profile, "name") || (index === 0 ? "Default" : `Profile ${index + 1}`),
				apiConfiguration,
				planActSeparateModelsSetting:
					typeof profile.planActSeparateModelsSetting === "boolean"
						? profile.planActSeparateModelsSetting
						: fallbackPlanActSeparateModelsSetting,
				createdAt: getString(profile, "createdAt") || now,
				updatedAt: getString(profile, "updatedAt") || now,
			}
		})
		.filter((profile): profile is typeof fallbackProfile => Boolean(profile))

	return profiles.length > 0 ? profiles : [fallbackProfile]
}

export function normalizePreferredLanguage(value: string) {
	const normalized = value.trim().toLowerCase()
	return normalized === "korean" || normalized === "korean - 한국어" || normalized === "한국어"
		? "Korean - 한국어"
		: "English"
}

export function resolveOAuthCredentials(apiConfig: Record<string, unknown>, providerId: string) {
	const field = oauthCredentialsField(providerId)
	const raw = getString(apiConfig, field)
	if (!raw) {
		return {}
	}

	const parsed = asRecord(tryParseJson(raw) ?? {})
	return Object.keys(parsed).length > 0 ? parsed : { accessToken: raw }
}

export function describeOAuthCredentialState(credentials: Record<string, unknown>) {
	const expiresAt = numberValue(credentials.expiresAt) || numberValue(credentials.expires_at)
	const refreshToken = getString(credentials, "refreshToken") || getString(credentials, "refresh_token")
	if (!Object.keys(credentials).length) {
		return { refreshStatus: "none", refreshSupported: false, expiresAt: undefined as number | undefined }
	}
	if (!expiresAt) {
		return { refreshStatus: refreshToken ? "refreshable" : "unknown", refreshSupported: Boolean(refreshToken), expiresAt: undefined as number | undefined }
	}
	const skewMs = readPositiveIntEnv("VSCLINE_OAUTH_EXPIRY_SKEW_MS", 60_000)
	const refreshStatus = expiresAt <= Date.now() + skewMs ? "expired" : refreshToken ? "refreshable" : "valid"
	return { refreshStatus, refreshSupported: Boolean(refreshToken), expiresAt }
}

export async function refreshOAuthToken(provider: string, refreshToken: string, exchange: OAuthTokenExchangeConfig) {
	const body = new URLSearchParams()
	body.set("grant_type", "refresh_token")
	body.set("refresh_token", refreshToken)
	body.set("client_id", exchange.clientId)
	if (exchange.clientSecret && exchange.authMethod !== "client_secret_basic") {
		body.set("client_secret", exchange.clientSecret)
	}
	if (exchange.scope) {
		body.set("scope", exchange.scope)
	}
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	}
	if (exchange.clientSecret && exchange.authMethod === "client_secret_basic") {
		headers.authorization = `Basic ${Buffer.from(`${exchange.clientId}:${exchange.clientSecret}`).toString("base64")}`
	}
	const response = await fetch(exchange.tokenUrl, { method: "POST", headers, body })
	const text = await response.text()
	const parsed = asRecord(tryParseJson(text) ?? {})
	if (!response.ok) {
		const error = getString(parsed, "error_description") || getString(parsed, "error") || truncateText(text, 500)
		throw new Error(`Token refresh for ${providerAuthLabel(provider)} returned HTTP ${response.status}: ${error || response.statusText}`)
	}
	const accessToken = getString(parsed, "access_token") || getString(parsed, "token")
	if (!accessToken) {
		throw new Error(`Token refresh for ${providerAuthLabel(provider)} did not include access_token.`)
	}
	const expiresIn = getNumber(parsed, "expires_in")
	return {
		accessToken,
		refreshToken: getString(parsed, "refresh_token") || refreshToken,
		tokenType: getString(parsed, "token_type") || undefined,
		expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
		tokenResponse: parsed,
	}
}

export function extractAutoApprovalSettingsUpdate(request: Record<string, unknown>) {
	const candidates = [
		request.autoApprovalSettings,
		request.settings,
		request.value,
		request.state,
		request.autoApproval,
	]

	for (const candidate of candidates) {
		const record = asRecord(candidate)
		if (isAutoApprovalSettingsLike(record)) {
			return record
		}
	}

	if (isAutoApprovalSettingsLike(request)) {
		return request
	}

	const actionKeys = [
		"readFiles",
		"readFilesExternally",
		"editFiles",
		"editFilesExternally",
		"executeSafeCommands",
		"executeAllCommands",
		"useBrowser",
		"useMcp",
		"useMcpServers",
	]
	const actions: Record<string, unknown> = {}
	for (const key of actionKeys) {
		if (key in request) {
			actions[key] = request[key]
		}
	}
	return Object.keys(actions).length > 0 ? { actions } : {}
}

export function isAutoApprovalSettingsLike(record: Record<string, unknown>) {
	return "actions" in record || "enabled" in record || "maxRequests" in record || "favorites" in record
}

export function createToolPolicies(autoApprovalSettings: unknown, browserSettings: unknown = {}, mode: unknown = "act") {
	const settings = asRecord(autoApprovalSettings)
	const actions = asRecord(settings.actions)
	const autoApproveAll = settings.enabled === true
	const webFetchEnabled = isWebFetchEnabled(browserSettings)
	const readAuto = autoApproveAll && actions.readFiles === true
	const editAuto = autoApproveAll && actions.editFiles === true
	const commandAuto = autoApproveAll && (actions.executeAllCommands === true || actions.executeSafeCommands === true)
	const mcpAuto = autoApproveAll && (actions.useMcp === true || actions.useMcpServers === true)

	const policy = {
		readFile: { enabled: true, autoApprove: readAuto },
		read_file: { enabled: true, autoApprove: readAuto },
		read: { enabled: true, autoApprove: readAuto },
		read_files: { enabled: true, autoApprove: readAuto },
		search: { enabled: true, autoApprove: readAuto },
		grep: { enabled: true, autoApprove: readAuto },
		glob: { enabled: true, autoApprove: readAuto },
		searchFiles: { enabled: true, autoApprove: readAuto },
		search_files: { enabled: true, autoApprove: readAuto },
		search_codebase: { enabled: true, autoApprove: readAuto },
		editor: { enabled: true, autoApprove: editAuto },
		edit: { enabled: true, autoApprove: editAuto },
		applyPatch: { enabled: true, autoApprove: editAuto },
		apply_patch: { enabled: true, autoApprove: editAuto },
		bash: { enabled: true, autoApprove: commandAuto },
		executeCommand: { enabled: true, autoApprove: commandAuto },
		execute_command: { enabled: true, autoApprove: commandAuto },
		runCommand: { enabled: true, autoApprove: commandAuto },
		run_command: { enabled: true, autoApprove: commandAuto },
		run_commands: { enabled: true, autoApprove: commandAuto },
		fetch_web_content: { enabled: webFetchEnabled, autoApprove: false },
		skills: { enabled: true, autoApprove: false },
		useMcpServer: { enabled: true, autoApprove: mcpAuto },
		use_mcp_server: { enabled: true, autoApprove: mcpAuto },
		ask_question: { enabled: true, autoApprove: true },
		submit_and_exit: { enabled: true, autoApprove: true },
	}
	if (mode === "plan") {
		const blockedTools: string[] = []
		for (const key of Object.keys(policy) as Array<keyof typeof policy>) {
			if (isPlanModeBlockedTool(key)) {
				policy[key] = { enabled: false, autoApprove: false }
				blockedTools.push(String(key))
			}
		}
	}
	return policy
}

export function isPlanModeBlockedTool(toolName: string) {
	const mapped = mapToolName(toolName)
	return mapped === "executeCommand" ||
		mapped === "editedExistingFile" ||
		mapped === "useMcpServer" ||
		mapped === "fetch_web_content" ||
		mapped === "browser_action_launch" ||
		mapped === "browser" ||
		mapped === "skills"
}

export function resolveRequestedPlanActMode(message: unknown, currentMode: string) {
	const record = asRecord(message)
	const raw = String(record.mode ?? record.value ?? "").toLowerCase()
	if (raw === "plan" || raw === "planactmode.plan" || raw === "0") {
		return "plan"
	}
	if (raw === "act" || raw === "planactmode.act" || raw === "1") {
		return "act"
	}
	return currentMode === "plan" ? "act" : "plan"
}

export function isWebFetchEnabled(browserSettings: unknown) {
	const settings = asRecord(browserSettings)
	return settings.disableToolUse !== true
}

export function webFetchDisabledReason(browserSettings: unknown) {
	if (asRecord(browserSettings).disableToolUse === true) {
		return "Browser/web tool usage is disabled in settings."
	}
	return ""
}

export function isRuntimeSettingsKey(key: string) {
	return (
		key === "mode" ||
		key === "planActSeparateModelsSetting" ||
		key === "preferredLanguage" ||
		key === "subagentsEnabled" ||
		key === "scheduledAgentsEnabled" ||
		key === "hooksEnabled" ||
		key === "enableCheckpointsSetting" ||
		key === "yoloModeToggled" ||
		key === "doubleCheckCompletionEnabled" ||
		key === "enableParallelToolCalling" ||
		key === "nativeToolCallEnabled" ||
		key === "strictPlanModeEnabled" ||
		key === "useAutoCondense" ||
		key === "customPrompt"
	)
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function getBoolean(value: unknown, key: string) { return asRecord(value)[key] === true }
function getNumber(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "number" && Number.isFinite(item) ? item : undefined }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function arrayOfRecords(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [] }
function tryParseJson(value: string) { try { return JSON.parse(value) as unknown } catch { return undefined } }
function truncateText(value: string, maxChars: number) { return value.length <= maxChars ? value : value.slice(0, maxChars) + "\n\n[truncated " + (value.length - maxChars) + " chars]" }
function stringify(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value) } catch { return String(value) } }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
