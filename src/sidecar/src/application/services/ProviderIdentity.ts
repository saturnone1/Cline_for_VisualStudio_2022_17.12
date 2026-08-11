export const protoApiProviderIds: Record<number, string> = {
	0: "anthropic",
	1: "openrouter",
	2: "bedrock",
	3: "vertex",
	4: "openai",
	5: "ollama",
	6: "lmstudio",
	7: "gemini",
	8: "openai-native",
	9: "requesty",
	10: "together",
	11: "deepseek",
	12: "qwen",
	13: "doubao",
	14: "mistral",
	15: "vscode-lm",
	16: "cline",
	17: "litellm",
	18: "nebius",
	19: "fireworks",
	20: "asksage",
	21: "xai",
	22: "sambanova",
	23: "cerebras",
	24: "groq",
	25: "sapaicore",
	26: "claude-code",
	27: "moonshot",
	28: "huggingface",
	29: "huawei-cloud-maas",
	30: "baseten",
	31: "zai",
	32: "vercel-ai-gateway",
	33: "qwen-code",
	34: "dify",
	35: "oca",
	36: "minimax",
	37: "hicap",
	38: "aihubmix",
	39: "nousResearch",
	40: "openai-codex",
	41: "wandb",
}

export function normalizeProviderValue(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) {
		return protoApiProviderIds[value] || "anthropic"
	}
	if (typeof value === "string") {
		return normalizeProviderId(value)
	}
	const record = asRecord(value)
	const name = getString(record, "name")
	if (name) {
		return normalizeProviderId(name)
	}
	const id = numberValue(record.id) ?? numberValue(record.value)
	if (id !== undefined) {
		return protoApiProviderIds[id] || "anthropic"
	}
	return ""
}

export function normalizeProviderId(providerId: string) {
	const providerMap: Record<string, string> = {
		ANTHROPIC: "anthropic",
		OPENROUTER: "openrouter",
		BEDROCK: "bedrock",
		VERTEX: "vertex",
		OPENAI: "openai",
		OLLAMA: "ollama",
		LMSTUDIO: "lmstudio",
		GEMINI: "gemini",
		OPENAI_NATIVE: "openai-native",
		REQUESTY: "requesty",
		TOGETHER: "together",
		DEEPSEEK: "deepseek",
		QWEN: "qwen",
		QWEN_CODE: "qwen-code",
		DOUBAO: "doubao",
		MISTRAL: "mistral",
		VSCODE_LM: "vscode-lm",
		CLINE: "cline",
		LITELLM: "litellm",
		MOONSHOT: "moonshot",
		HUGGINGFACE: "huggingface",
		NEBIUS: "nebius",
		WANDB: "wandb",
		FIREWORKS: "fireworks",
		ASKSAGE: "asksage",
		XAI: "xai",
		SAMBANOVA: "sambanova",
		CEREBRAS: "cerebras",
		GROQ: "groq",
		BASETEN: "baseten",
		SAPAICORE: "sapaicore",
		CLAUDE_CODE: "claude-code",
		HUAWEI_CLOUD_MAAS: "huawei-cloud-maas",
		VERCEL_AI_GATEWAY: "vercel-ai-gateway",
		ZAI: "zai",
		DIFY: "dify",
		OCA: "oca",
		AIHUBMIX: "aihubmix",
		MINIMAX: "minimax",
		HICAP: "hicap",
		NOUSRESEARCH: "nousResearch",
		OPENAI_CODEX: "openai-codex",
		LIG: "account",
		LIGVS: "account",
		LIG_VS: "account",
		ACCOUNT: "account",
	}
	if (providerMap[providerId]) {
		return providerMap[providerId]
	}
	if (providerId === "openai") {
		return "openai"
	}
	if (providerId === "openai-compatible") {
		return "openai-compatible"
	}
	return providerId
}

export function normalizeSdkProviderId(providerId: string) {
	// The upstream webview uses "openai" for the OpenAI Compatible option, while
	// @cline/sdk registers that provider as "openai-compatible".
	if (providerId === "openai") {
		return "openai-compatible"
	}
	return providerId
}

export function oauthCredentialsField(provider: string) {
	const normalized = normalizeProviderValue(provider)
	switch (normalized) {
		case "openai-codex":
			return "openAiCodexOAuthCredentials"
		case "oca":
			return "ocaOAuthCredentials"
		case "account":
			return "ligVsOAuthCredentials"
		default:
			return `${normalized || "provider"}OAuthCredentials`
	}
}

export function isOAuthTokenBlobProvider(provider: string) {
	const normalized = normalizeProviderValue(provider)
	return normalized === "openai-codex" || normalized === "oca" || normalized === "account"
}

export function providerAuthLabel(provider: string) {
	switch (provider) {
		case "anthropic":
			return "Anthropic"
		case "openrouter":
			return "OpenRouter"
		case "openai":
		case "openai-compatible":
			return "OpenAI Compatible"
		case "openai-native":
			return "OpenAI"
		case "ollama":
			return "Ollama"
		case "lmstudio":
			return "LM Studio"
		case "litellm":
			return "LiteLLM"
		case "requesty":
			return "Requesty"
		case "vercel-ai-gateway":
			return "Vercel AI Gateway"
		case "groq":
			return "Groq"
		case "huggingface":
			return "Hugging Face"
		case "baseten":
			return "Baseten"
		case "hicap":
			return "Hicap"
		case "sapaicore":
			return "SAP AI Core"
		case "aihubmix":
			return "AIHubMix"
		case "nousResearch":
			return "Nous Research"
		case "openAiCodex":
		case "openai-codex":
			return "OpenAI Codex"
		case "oca":
			return "OCA"
		case "account":
			return "LIG VS account"
		default:
			return provider || "Provider"
	}
}

function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(record: Record<string, unknown>, key: string) { const value = record[key]; return typeof value === "string" ? value : value == null ? "" : String(value) }
