import type { OAuthTokenExchangePort } from "../../application/ports/OAuthTokenExchangePort"
import type { ProviderCredentialEnvironmentPort } from "../../application/ports/ProviderCredentialEnvironmentPort"
import type { AgentEnginePort } from "../../application/ports/AgentEnginePort"
import { isOAuthTokenBlobProvider, normalizeProviderValue, normalizeSdkProviderId, oauthCredentialsField, providerAuthLabel } from "../../application/services/ProviderIdentity"
import type { OAuthCallbackSession } from "./OAuthCallbackCoordinator"
import { createFallbackProviderConfigFields, describeOAuthCredentialState, extractProviderCredentialValue, isOAuthBridgeProvider, providerBaseUrlField, providerCredentialField, resolveOAuthCredentials } from "./ProviderCredentialPolicy"

export type ProviderCredentialMutation = Readonly<{
	updates?: Readonly<Record<string, unknown>>
	deletes?: readonly string[]
	openAiCodexAuthenticated?: boolean
	response: Readonly<Record<string, unknown>>
	log?: Readonly<{ event: string; details: Readonly<Record<string, unknown>> }>
}>

export class ProviderCredentialHandler {
	constructor(private readonly environment: ProviderCredentialEnvironmentPort, private readonly tokens: OAuthTokenExchangePort, private readonly agentEngine: AgentEnginePort) {}

	save(message: unknown): ProviderCredentialMutation {
		const request = asRecord(message), provider = providerFrom(request)
		if (!provider) return responseOnly({ success: false, message: "Provider is required.", authStatus: "unknown" })
		const credential = extractProviderCredentialValue(request)
		if (!credential) return responseOnly({ success: false, provider, message: "Credential value is required.", authStatus: "unauthenticated" })
		const field = providerCredentialField(provider)
		if (!field) return responseOnly({ success: false, provider, message: `${providerAuthLabel(provider)} credential storage is not mapped for the Visual Studio host yet.`, authStatus: "unsupported" })
		const updates: Record<string, unknown> = { [field]: credential }
		const baseUrl = readString(request.baseUrl) || readString(request.url) || readString(request.endpoint), baseUrlField = providerBaseUrlField(provider)
		if (baseUrl && baseUrlField) updates[baseUrlField] = baseUrl
		return { updates, response: { success: true, provider, authStatus: "configured", isAuthenticated: true, field, hasCredential: true, message: `${providerAuthLabel(provider)} credential was saved to local LIG VS settings.` }, log: { event: "providerCredentialSaved", details: { provider, field, hasBaseUrl: Boolean(baseUrl && baseUrlField), source: readString(request.source) || undefined } } }
	}

	status(message: unknown, configuration: Readonly<Record<string, unknown>>) {
		const provider = providerFrom(asRecord(message))
		if (!provider) return { success: false, message: "Provider is required.", authStatus: "unknown" }
		const field = providerCredentialField(provider), baseUrlField = providerBaseUrlField(provider)
		const credential = field ? readString(configuration[field]) : ""
		const oauth = resolveOAuthCredentials({ ...configuration }, provider), hasOAuthCredential = Object.keys(oauth).length > 0
		const oauthState = describeOAuthCredentialState(oauth, Date.now(), this.environment.oauthExpirySkewMs)
		const envCredential = this.environment.resolveApiKey(provider)
		const baseUrl = (baseUrlField ? readString(configuration[baseUrlField]) : "") || this.environment.resolveBaseUrl(provider)
		const tokenExchange = this.environment.createTokenExchangeConfig(provider, {})
		return { success: true, provider, supported: Boolean(field) || isOAuthTokenBlobProvider(provider), authStatus: credential || hasOAuthCredential ? "configured" : envCredential ? "environment" : field || isOAuthTokenBlobProvider(provider) ? "unauthenticated" : "unsupported", isAuthenticated: Boolean(credential || hasOAuthCredential || envCredential), hasCredential: Boolean(credential || hasOAuthCredential), hasOAuthCredential, oauthExpiresAt: oauthState.expiresAt, oauthRefreshStatus: oauthState.refreshStatus, oauthRefreshSupported: oauthState.refreshSupported && Boolean(tokenExchange), oauthRefreshRequired: oauthState.refreshStatus === "expired", hasEnvironmentCredential: Boolean(envCredential), field: field || (isOAuthTokenBlobProvider(provider) ? oauthCredentialsField(provider) : undefined), baseUrl: baseUrl || undefined, baseUrlField: baseUrlField || undefined, sdkProviderId: normalizeSdkProviderId(provider) }
	}

	async getConfigFields(message: unknown, configuration: Readonly<Record<string, unknown>>) {
		const request = asRecord(message), provider = providerFrom(request)
		if (!provider) return { success: false, message: "Provider is required.", authStatus: "unknown" }
		const sdkProviderId = normalizeSdkProviderId(provider), credentialStatus = this.status({ provider }, configuration)
		try {
			const fields = asRecord((await this.agentEngine.getProviderConfigFields(sdkProviderId)) ?? createFallbackProviderConfigFields(provider))
			return { ...credentialStatus, ...configFieldsResponse(provider, sdkProviderId, fields, this.environment) }
		} catch (error) {
			const fallback = createFallbackProviderConfigFields(provider)
			return { ...credentialStatus, success: true, provider, sdkProviderId, supported: Boolean(providerCredentialField(provider)), authMethod: fallback.authMethod, fields: fallback.fields, message: `Using fallback provider auth metadata for ${providerAuthLabel(provider)} because SDK provider metadata could not be loaded.`, error: error instanceof Error ? error.message : String(error) }
		}
	}

	async refresh(message: unknown, configuration: Readonly<Record<string, unknown>>): Promise<ProviderCredentialMutation> {
		const request = asRecord(message), provider = providerFrom(request)
		if (!provider) return responseOnly({ success: false, message: "Provider is required.", authStatus: "unknown" })
		if (!["openai-codex", "oca", "account", "lig"].includes(provider)) return responseOnly({ success: false, provider, authStatus: "unsupported", message: `${providerAuthLabel(provider)} OAuth refresh is not required for this Visual Studio deployment scope.` })
		const credentials = resolveOAuthCredentials({ ...configuration }, provider)
		const refreshToken = readString(credentials.refreshToken) || readString(credentials.refresh_token)
		if (!refreshToken) return responseOnly({ ...this.status({ provider }, configuration), success: false, message: `${providerAuthLabel(provider)} has no stored refresh token.` })
		const exchange = this.environment.createTokenExchangeConfig(provider, request)
		if (!exchange) return responseOnly({ ...this.status({ provider }, configuration), success: false, message: `${providerAuthLabel(provider)} refresh requires a configured token endpoint and client id.` })
		const result = await this.tokens.refreshAccessToken({ ...exchange, refreshToken })
		const merged = { ...credentials, accessToken: result.accessToken, refreshToken: result.refreshToken || refreshToken, tokenType: result.tokenType, expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined, tokenResponse: result.rawResponse, provider, receivedAt: Date.now() }
		const next = { ...configuration, [oauthCredentialsField(provider)]: JSON.stringify(merged) }
		return { updates: { [oauthCredentialsField(provider)]: next[oauthCredentialsField(provider)] }, openAiCodexAuthenticated: provider === "openai-codex" ? true : undefined, response: { ...this.status({ provider }, next), success: true, authStatus: "configured", message: `${providerAuthLabel(provider)} OAuth credential was refreshed.` }, log: { event: "oauthTokenRefreshed", details: { provider, expiresAt: merged.expiresAt, hasRefreshToken: Boolean(merged.refreshToken) } } }
	}

	clear(message: unknown): ProviderCredentialMutation {
		const request = asRecord(message), provider = providerFrom(request)
		if (!provider) return responseOnly({ success: false, message: "Provider is required.", authStatus: "unknown" })
		const field = providerCredentialField(provider) || (isOAuthTokenBlobProvider(provider) ? oauthCredentialsField(provider) : "")
		if (!field) return responseOnly({ success: false, provider, message: `${providerAuthLabel(provider)} credential storage is not mapped.`, authStatus: "unsupported" })
		const deletes = [field]
		const baseUrlField = providerBaseUrlField(provider)
		if (request.clearBaseUrl === true && baseUrlField) deletes.push(baseUrlField)
		return { deletes, response: { success: true, provider, authStatus: "unauthenticated", isAuthenticated: false, hasCredential: false, message: `${providerAuthLabel(provider)} credential was removed from local LIG VS settings.` }, log: { event: "providerCredentialCleared", details: { provider, field } } }
	}

	persistOAuthSession(session: OAuthCallbackSession): ProviderCredentialMutation {
		const field = providerCredentialField(session.provider)
		if (field) return this.save({ provider: session.provider, value: session.token, source: "oauth_callback" })
		if (!isOAuthTokenBlobProvider(session.provider)) { session.status = "received"; session.message = `${providerAuthLabel(session.provider)} OAuth token was received, but LIG VS has no credential storage mapping for this provider yet.`; return responseOnly({ success: false, provider: session.provider, authStatus: "unsupported", hasToken: true, message: session.message }) }
		const credentials = { provider: session.provider, accessToken: session.token, refreshToken: session.refreshToken, tokenType: session.tokenType, expiresAt: session.expiresAt, receivedAt: Date.now(), tokenResponse: session.tokenResponse }
		session.status = "configured"
		session.message = `${providerAuthLabel(session.provider)} OAuth credential was saved to local LIG VS settings.`
		return { updates: { [oauthCredentialsField(session.provider)]: JSON.stringify(credentials) }, openAiCodexAuthenticated: normalizeProviderValue(session.provider) === "openai-codex" ? true : undefined, response: { success: true, provider: session.provider, authStatus: "configured", isAuthenticated: true, hasCredential: true, message: session.message }, log: { event: "oauthTokenBlobSaved", details: { provider: session.provider, state: session.state, hasRefreshToken: Boolean(session.refreshToken) } } }
	}
}

function responseOnly(response: Readonly<Record<string, unknown>>): ProviderCredentialMutation { return { response } }
function providerFrom(request: Record<string, unknown>) { return normalizeProviderValue(readString(request.provider) || readString(request.providerId) || readString(request.apiProvider)) }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function configFieldsResponse(provider: string, sdkProviderId: string, fields: Record<string, unknown>, environment: ProviderCredentialEnvironmentPort) {
	const authMethod = readString(fields.authMethod) || "api-key"
	const supportsLocal = Boolean(providerCredentialField(provider))
	const supported = authMethod === "oauth" ? isOAuthBridgeProvider(provider) : authMethod === "api-key" ? supportsLocal : true
	const tokenExchangeSupported = Boolean(environment.createTokenExchangeConfig(provider, {}))
	const message = authMethod === "oauth" ? tokenExchangeSupported ? `${providerAuthLabel(provider)} uses OAuth in the upstream SDK. LIG VS can open configured authorization URLs, receive localhost callback redirects, exchange authorization codes at the configured token endpoint, and store local OAuth credentials.` : `${providerAuthLabel(provider)} uses OAuth in the upstream SDK. LIG VS can receive localhost callback redirects; set provider OAuth token endpoint and client metadata to enable local token exchange.` : authMethod === "local" ? `${providerAuthLabel(provider)} is a local/provider-managed auth flow. LIG VS will report readiness but does not fake sign-in.` : `${providerAuthLabel(provider)} can be configured with local credentials in LIG VS settings.`
	return { success: true, provider, sdkProviderId, supported, authMethod, fields: asRecord(fields.fields), description: readString(fields.description) || undefined, callbackSupported: authMethod === "oauth" ? isOAuthBridgeProvider(provider) : undefined, authorizationUrlSupported: authMethod === "oauth" ? environment.hasAuthorizationUrl(provider) : undefined, tokenExchangeSupported: authMethod === "oauth" ? tokenExchangeSupported : undefined, message }
}
