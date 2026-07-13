import { normalizeProviderId, providerAuthLabel } from "../../application/services/ProviderIdentity"
import { compactApiConfiguration, describeOAuthCredentialState, resolveApiKey, resolveBaseUrl, resolveOAuthCredentials } from "../configuration/ProviderConfiguration"
import type { ProviderCatalogRequest } from "../../features/providers/ModelCatalogRpcHandler"
import { resolveModelId } from "../../features/providers/ProviderSelection"
import { createCatalogDiagnostics, createModelCatalog, defaultOpenAiCompatibleCatalogBaseUrl, getOllamaModels, getOpenAiCompatibleModels, isOpenAiCompatibleCatalogProvider, normalizeOllamaRootBaseUrl, normalizeOpenAiCompatibleBaseUrl } from "./ModelCatalog"

export class ProviderModelCatalogHandler {
	constructor(private readonly applyDefaultOllamaModel: (modelId: string) => void) {}

	current(configuration: Record<string, unknown>, mode: "plan" | "act", modelId: string) {
		const modePrefix = mode === "plan" ? "planMode" : "actMode"
		return createModelCatalog([modelId], { providerId: normalizeProviderId(readString(configuration[`${modePrefix}ApiProvider`])), selectedId: modelId, reduced: true, message: "Using the configured model because this provider catalog cannot be refreshed locally." })
	}

	async refresh(providerId: string, request: ProviderCatalogRequest, configuration: Record<string, unknown>, mode: "plan" | "act", fallbackModelId: string) {
		const provider = normalizeProviderId(providerId), apiConfig = { ...configuration, ...compactApiConfiguration(request.apiConfigurationUpdate) }
		const modePrefix = mode === "plan" ? "planMode" : "actMode", selectedId = resolveModelId(apiConfig, provider, modePrefix) || fallbackModelId
		const oauthCredentials = resolveOAuthCredentials(apiConfig, provider), oauthState = describeOAuthCredentialState(oauthCredentials)
		const apiKey = resolveApiKey(apiConfig, provider) || readString(oauthCredentials.accessToken) || readString(oauthCredentials.access_token)
		const requestedBaseUrl = request.baseUrl
		const configuredBaseUrl = requestedBaseUrl || resolveBaseUrl(apiConfig, provider)
		const baseUrl = provider === "lmstudio" && !configuredBaseUrl ? "http://localhost:1234/v1" : configuredBaseUrl || defaultOpenAiCompatibleCatalogBaseUrl(provider, apiKey)

		if (provider === "ollama") {
			const ids = await getOllamaModels(baseUrl)
			if (ids.length) this.applyDefaultOllamaModel(ids[0])
			return createModelCatalog(ids, { providerId: provider, selectedId: selectedId || ids[0], source: "ollama:/api/tags", supported: true, reduced: ids.length === 0, message: ids.length ? "" : "Ollama did not return any local models. Check that Ollama is running and has pulled models.", diagnostics: createCatalogDiagnostics(provider, "ollama:/api/tags", { baseUrl: normalizeOllamaRootBaseUrl(baseUrl), authenticated: false, modelCount: ids.length }) })
		}

		if (!isOpenAiCompatibleCatalogProvider(provider)) return this.unsupported(`ModelsService.refresh:${provider}`)
		if (!baseUrl) return createModelCatalog(selectedId ? [selectedId] : [], { providerId: provider, selectedId, supported: true, reduced: true, message: `${providerAuthLabel(provider)} does not expose a configured model catalog endpoint in this Visual Studio port, so the configured model is shown as a reduced catalog.`, diagnostics: createCatalogDiagnostics(provider, "reduced", { baseUrlConfigured: false, authenticated: Boolean(apiKey), oauthRefreshStatus: oauthState.refreshStatus }) })

		const result = await getOpenAiCompatibleModels(baseUrl, apiKey)
		return createModelCatalog(result.ids, { providerId: provider, selectedId: selectedId || result.ids[0], source: `${normalizeOpenAiCompatibleBaseUrl(baseUrl)}/models`, supported: true, reduced: result.ids.length === 0, message: result.error || (result.ids.length ? "" : "The model endpoint returned no models."), error: result.error, modelInfoById: result.modelInfoById, diagnostics: createCatalogDiagnostics(provider, "openai-compatible:/models", { baseUrl: normalizeOpenAiCompatibleBaseUrl(baseUrl), authenticated: Boolean(apiKey), oauthRefreshStatus: oauthState.refreshStatus, modelCount: result.ids.length, error: result.error }) })
	}

	async ollamaValues(baseUrl: string) {
		const values = await getOllamaModels(baseUrl)
		if (values.length) this.applyDefaultOllamaModel(values[0])
		return { values }
	}

	async lmStudioValues(baseUrl: string) {
		const result = await getOpenAiCompatibleModels(baseUrl || "http://localhost:1234/v1", "")
		return {
			values: result.ids.map((id) => {
				const info = result.modelInfoById[id] || {}
				return JSON.stringify({ id, ...info, max_context_length: readNumber(info.max_context_length) || readNumber(info.contextWindow) || 128_000 })
			}),
			error: result.error,
		}
	}

	async askSageModels(baseUrl: string) {
		try {
			const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/get-models`)
			if (!response.ok) return { values: [], error: `AskSage model endpoint returned HTTP ${response.status}.` }
			const payload = asRecord(await response.json())
			return { values: Array.isArray(payload.response) ? payload.response.filter((value): value is string => typeof value === "string") : [] }
		} catch (error) {
			return { values: [], error: stringify(error) }
		}
	}

	async openRouterKeyInfo(apiKey: string) {
		if (!apiKey) return { data: null, error: "OpenRouter API key is required." }
		try {
			const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${apiKey}` } })
			if (!response.ok) return { data: null, error: `OpenRouter key endpoint returned HTTP ${response.status}.` }
			const data = asRecord(asRecord(await response.json()).data)
			return { data: { limit: readNullableNumber(data.limit), usage: readNumber(data.usage), limitRemaining: readNullableNumber(data.limit_remaining), isFreeTier: data.is_free_tier === true } }
		} catch (error) {
			return { data: null, error: stringify(error) }
		}
	}

	unsupported(key: string) {
		if (key === "ModelsService.getVsCodeLmModels") return { models: [], supported: false, message: "VS Code language models are not available in the Visual Studio host." }
		if (key === "ModelsService.getSapAiCoreModels") return { deployments: [], orchestrationAvailable: false, supported: false, message: "SAP AI Core discovery is not implemented in the Visual Studio host." }
		if (key === "ModelsService.refreshClineRecommendedModelsRpc") return { recommended: [], free: [], supported: false, message: "Online Cline recommendations are unavailable in air-gap Visual Studio mode." }
		const providerId = key.replace(/^ModelsService\./, "").replace(/Rpc$/, "")
		return createModelCatalog([], { providerId, supported: false, reduced: true, message: `${key} is not implemented in the air-gap Visual Studio port. Configure a local Ollama, LM Studio, LiteLLM, or OpenAI-compatible endpoint instead.`, diagnostics: createCatalogDiagnostics(providerId, "unsupported", { authenticated: false, reason: "air_gap_provider_catalog_not_implemented" }) })
	}
}


function readString(value: unknown) { return typeof value === "string" ? value : "" }
function readNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
function readNullableNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
