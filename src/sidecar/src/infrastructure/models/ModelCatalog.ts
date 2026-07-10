export function normalizeOllamaRootBaseUrl(baseUrl: string) {
	return (baseUrl || "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/i, "")
}

export function normalizeOllamaOpenAiBaseUrl(baseUrl: string) {
	return `${normalizeOllamaRootBaseUrl(baseUrl)}/v1`
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string) {
	const normalized = (baseUrl || "").replace(/\/+$/, "")
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`
}

export function isOpenAiCompatibleCatalogProvider(providerId: string) {
	return [
		"openai",
		"openai-compatible",
		"openai-native",
		"lmstudio",
		"litellm",
		"openrouter",
		"requesty",
		"groq",
		"vercel-ai-gateway",
		"huggingface",
		"baseten",
		"aihubmix",
		"hicap",
		"oca",
		"sapaicore",
	].includes(providerId)
}

export function defaultOpenAiCompatibleCatalogBaseUrl(providerId: string, apiKey: string) {
	if (!apiKey) {
		return ""
	}

	const defaults: Record<string, string> = {
		openrouter: "https://openrouter.ai/api/v1",
		requesty: "https://router.requesty.ai/v1",
		groq: "https://api.groq.com/openai/v1",
		"vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1",
	}
	return defaults[providerId] || ""
}

export function createModelCatalog(
	ids: string[],
	options: {
		providerId?: string
		selectedId?: string
		source?: string
		supported?: boolean
		reduced?: boolean
		message?: string
		error?: string
		modelInfoById?: Record<string, Record<string, unknown>>
		diagnostics?: Record<string, unknown>
	} = {},
) {
	const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)))
	const values = uniqueIds.map((id) => {
		const inferred = inferModelInfo(id, options.providerId || "")
		const remote = options.modelInfoById?.[id] || {}
		return {
			id,
			name: getString(remote, "name") || id,
			...inferred,
			...remote,
			capabilities: modelCapabilities({ ...inferred, ...remote }),
			providerId: options.providerId || undefined,
		}
	})
	const models = values.reduce<Record<string, (typeof values)[number]>>((acc, model) => {
		acc[model.id] = model
		return acc
	}, {})

	return {
		models,
		values,
		items: values,
		modelIds: uniqueIds,
		selectedId: options.selectedId || uniqueIds[0] || "",
		providerId: options.providerId || "",
		source: options.source || "",
		supported: options.supported !== false,
		reduced: options.reduced === true,
		message: options.message || "",
		error: options.error || "",
		diagnostics: options.diagnostics || {},
	}
}

export function createCatalogDiagnostics(providerId: string, source: string, details: Record<string, unknown>) {
	return {
		providerId,
		source,
		capabilitySource: "sdk/provider metadata first, endpoint metadata second, conservative inference last",
		airGap: true,
		...details,
		refreshedAt: Date.now(),
	}
}

export function inferModelInfo(id: string, providerId: string): Record<string, unknown> {
	const normalizedId = id.toLowerCase()
	const isClaude = normalizedId.includes("claude")
	const isGemini = normalizedId.includes("gemini")
	const isReasoning =
		/(^|[-/:.])(o[134]|o4-mini|o3-mini|reasoning|r1|qwq|gpt-oss|deepseek-r1)([-/:.]|$)/.test(normalizedId) ||
		normalizedId.includes("thinking")
	const supportsImages =
		isGemini ||
		isClaude ||
		normalizedId.includes("vision") ||
		normalizedId.includes("vl") ||
		normalizedId.includes("gpt-4o") ||
		normalizedId.includes("gpt-4.1")
	const contextWindow = inferContextWindow(normalizedId, providerId)
	const supportsPromptCache = isClaude || isGemini || normalizedId.includes("cache")

	return {
		contextWindow,
		maxTokens: inferMaxTokens(normalizedId, contextWindow),
		supportsImages,
		supportsPromptCache,
		supportsReasoning: isReasoning,
		supportsTools: true,
		supportsStreaming: true,
		description: `Model metadata inferred from provider catalog for ${id}.`,
	}
}

export function inferContextWindow(normalizedId: string, providerId: string) {
	if (normalizedId.includes("1m") || normalizedId.includes("1-million")) {
		return 1_000_000
	}
	if (normalizedId.includes("gemini-1.5-pro") || normalizedId.includes("gemini-2")) {
		return 1_000_000
	}
	if (normalizedId.includes("claude")) {
		return 200_000
	}
	if (normalizedId.includes("gpt-4.1") || normalizedId.includes("gpt-4o") || normalizedId.includes("o3") || normalizedId.includes("o4")) {
		return 128_000
	}
	if (normalizedId.includes("llama-3.1") || normalizedId.includes("llama-3.3")) {
		return 128_000
	}
	if (providerId === "groq") {
		return 131_072
	}
	return 128_000
}

export function inferMaxTokens(normalizedId: string, contextWindow: number) {
	if (normalizedId.includes("claude")) {
		return Math.min(contextWindow, 64_000)
	}
	if (normalizedId.includes("gemini")) {
		return Math.min(contextWindow, 65_536)
	}
	if (normalizedId.includes("o3") || normalizedId.includes("o4") || normalizedId.includes("gpt-4.1")) {
		return Math.min(contextWindow, 32_768)
	}
	return Math.min(contextWindow, 16_384)
}

export function modelCapabilities(modelInfo: Record<string, unknown>) {
	return [
		booleanField(modelInfo, "supportsTools") !== false ? "tools" : "",
		booleanField(modelInfo, "supportsReasoning") ? "reasoning" : "",
		booleanField(modelInfo, "supportsImages") ? "images" : "",
		booleanField(modelInfo, "supportsPromptCache") ? "prompt-cache" : "",
	].filter(Boolean)
}

export function booleanField(record: Record<string, unknown>, key: string) {
	return booleanValue(record[key])
}

export function modelInfoFromRemoteMetadata(id: string, metadata: Record<string, unknown>): Record<string, unknown> {
	const pricing = asRecord(metadata.pricing)
	const architecture = asRecord(metadata.architecture)
	const contextWindow =
		numberValue(metadata.context_length) ??
		numberValue(metadata.contextWindow) ??
		numberValue(metadata.max_context_length) ??
		numberValue(metadata.maxContextLength)
	const maxTokens =
		numberValue(metadata.max_completion_tokens) ??
		numberValue(metadata.maxTokens) ??
		numberValue(metadata.max_output_tokens) ??
		numberValue(metadata.maxOutputTokens)
	const inputPrice = parseModelPrice(pricing.prompt ?? pricing.input)
	const outputPrice = parseModelPrice(pricing.completion ?? pricing.output)
	const modality = [
		getString(metadata, "modality"),
		getString(architecture, "modality"),
		getString(architecture, "input_modalities"),
		getString(architecture, "output_modalities"),
	].join(" ").toLowerCase()
	const inferred = inferModelInfo(id, getString(metadata, "provider") || "")

	return {
		...inferred,
		name: getString(metadata, "name") || getString(metadata, "id") || id,
		contextWindow: contextWindow || inferred.contextWindow,
		maxTokens: maxTokens || inferred.maxTokens,
		supportsImages: modality.includes("image") || booleanField(metadata, "supportsImages") || inferred.supportsImages,
		supportsPromptCache: booleanField(metadata, "supportsPromptCache") || inferred.supportsPromptCache,
		supportsReasoning: booleanField(metadata, "supportsReasoning") || inferred.supportsReasoning,
		inputPrice,
		outputPrice,
		description: getString(metadata, "description") || inferred.description,
	}
}

export function parseModelPrice(value: unknown) {
	if (value === undefined || value === null || value === "") {
		return undefined
	}
	const numeric = Number(value)
	if (!Number.isFinite(numeric)) {
		return undefined
	}
	// OpenRouter-compatible catalogs often report per-token prices. The WebView expects per-million.
	return numeric > 0 && numeric < 0.001 ? numeric * 1_000_000 : numeric
}

export async function getOllamaModels(baseUrl: string) {
	const endpoint = `${normalizeOllamaRootBaseUrl(baseUrl)}/api/tags`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 2000)
	try {
		const response = await fetch(endpoint, { signal: controller.signal })
		if (!response.ok) {
			return []
		}

		const body = asRecord(await response.json())
		const models = Array.isArray(body.models) ? body.models : []
		return models
			.map((model) => getString(model, "name"))
			.filter((name): name is string => name.length > 0)
	} catch {
		return []
	} finally {
		clearTimeout(timeout)
	}
}

export async function getOpenAiCompatibleModels(
	baseUrl: string,
	apiKey: string,
): Promise<{ ids: string[]; modelInfoById: Record<string, Record<string, unknown>>; error: string }> {
	const endpoint = `${normalizeOpenAiCompatibleBaseUrl(baseUrl)}/models`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 3000)
	try {
		const headers: Record<string, string> = {}
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`
		}
		const response = await fetch(endpoint, { headers, signal: controller.signal })
		if (!response.ok) {
			return { ids: [], modelInfoById: {}, error: `Model endpoint returned HTTP ${response.status}.` }
		}

		const body = asRecord(await response.json())
		const candidates = Array.isArray(body.data)
			? body.data
			: Array.isArray(body.models)
				? body.models
				: Array.isArray(body.values)
					? body.values
					: []
		const modelInfoById: Record<string, Record<string, unknown>> = {}
		const ids = candidates
			.map((model) => {
				const record = asRecord(model)
				const id = typeof model === "string" ? model : getString(record, "id") || getString(record, "name")
				if (id && Object.keys(record).length > 0) {
					modelInfoById[id] = modelInfoFromRemoteMetadata(id, record)
				}
				return id
			})
			.filter((id): id is string => id.length > 0)
		return { ids, modelInfoById, error: "" }
	} catch (error) {
		const message = error instanceof Error && error.name === "AbortError"
			? "Model endpoint timed out."
			: `Model endpoint could not be reached: ${stringify(error)}`
		return { ids: [], modelInfoById: {}, error: message }
	} finally {
		clearTimeout(timeout)
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(record: Record<string, unknown>, key: string) { const value = record[key]; return typeof value === "string" ? value : value == null ? "" : String(value) }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function booleanValue(value: unknown) { return typeof value === "boolean" ? value : undefined }
function stringify(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value) } catch { return String(value) } }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
