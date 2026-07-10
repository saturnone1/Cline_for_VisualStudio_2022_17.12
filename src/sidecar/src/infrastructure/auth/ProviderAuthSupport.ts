import { createId } from "../conversation/ConversationSupport"
import {
	type OAuthTokenExchangeConfig,
	providerBaseUrlField,
	providerCredentialField,
	providerCredentialFields,
	resolveProviderEnvApiKey,
	resolveProviderEnvBaseUrl,
} from "../configuration/ProviderConfiguration"
import {
	isOAuthTokenBlobProvider,
	normalizeProviderValue,
	normalizeSdkProviderId,
	oauthCredentialsField,
	providerAuthLabel,
} from "../../application/services/ProviderIdentity"

export type OAuthCallbackSession = {
	provider: string
	state: string
	callbackUrl: string
	authorizationUrl?: string
	createdAt: number
	status: "pending" | "received" | "configured" | "error"
	code?: string
	token?: string
	refreshToken?: string
	tokenType?: string
	expiresAt?: number
	error?: string
	message?: string
	rawQuery?: Record<string, string>
	tokenExchangeSupported?: boolean
	tokenExchange?: OAuthTokenExchangeConfig
	tokenResponse?: Record<string, unknown>
}

export function createUnauthenticatedAccountState() {
	return {
		loggedIn: false,
		user: null,
		organizations: [],
		activeOrganization: null,
		isAuthenticated: false,
		openAiCodexIsAuthenticated: false,
		authStatus: "unauthenticated",
	}
}

export function createVisualStudioAuthUnsupportedResponse(provider: string, url = "") {
	const label = providerAuthLabel(provider)
	const message =
		`${label} OAuth is not implemented in the Visual Studio 2022 host yet. ` +
		"Use a local API key or a provider-specific credential file where available."
	return {
		success: false,
		supported: false,
		provider,
		url,
		value: url,
		message,
		reason: "visual_studio_oauth_callback_not_implemented",
		...createUnauthenticatedAccountState(),
	}
}

export function createFallbackProviderConfigFields(provider: string) {
	const providerId = normalizeSdkProviderId(provider)
	if (provider === "oca" || provider === "openAiCodex" || provider === "openai-codex" || provider === "account") {
		return {
			providerId,
			authMethod: "oauth",
			fields: {},
			description: `${providerAuthLabel(provider)} requires a Visual Studio-compatible OAuth callback/token exchange bridge.`,
		}
	}

	const fields: Record<string, Record<string, unknown>> = providerCredentialField(provider)
		? {
				apiKey: {
					label: `${providerAuthLabel(provider)} API Key`,
					placeholder: "Enter API Key...",
				},
			}
		: {}
	const baseUrlField = providerBaseUrlField(provider)
	if (baseUrlField) {
		fields.baseUrl = {
			label: "Base URL",
			placeholder: "https://...",
			optional: true,
		}
	}

	return {
		providerId,
		authMethod: Object.keys(fields).length > 0 ? "api-key" : "local",
		fields,
		description: `${providerAuthLabel(provider)} provider metadata is using the LIG VS fallback map.`,
	}
}

export function createProviderAuthInfo(provider: string, message: unknown, bridge: OAuthCallbackSession | null = null) {
	const request = asRecord(message)
	if (provider === "openrouter") {
		const url = "https://openrouter.ai/settings/keys"
		return {
			success: true,
			supported: true,
			provider,
			url,
			value: url,
			message: "OpenRouter API key page opened. Paste the generated key into LIG VS settings.",
			authMode: "api_key",
		}
	}

	if (provider === "requesty") {
		const configuredBaseUrl = getString(request, "value") || getString(request, "baseUrl")
		const root = normalizeHttpUrl(configuredBaseUrl) || "https://app.requesty.ai"
		const url = new URL("api-keys", root.endsWith("/") ? root : `${root}/`).toString()
		return {
			success: true,
			supported: true,
			provider,
			url,
			value: url,
			message: "Requesty API key page opened. Paste the generated key into LIG VS settings.",
			authMode: "api_key",
		}
	}

	if (provider === "hicap") {
		const url = "https://hicap.ai"
		return {
			success: true,
			supported: true,
			provider,
			url,
			value: url,
			message: "Hicap provider page opened. Use a local API key in LIG VS settings.",
			authMode: "api_key",
		}
	}

	if (bridge || isOAuthBridgeProvider(provider)) {
		const callbackUrl = bridge?.callbackUrl || ""
		const authorizationUrl = bridge?.authorizationUrl || ""
		return {
			...createUnauthenticatedAccountState(),
			success: true,
			supported: true,
			provider,
			value: authorizationUrl || callbackUrl,
			url: authorizationUrl || undefined,
			authorizationUrl: authorizationUrl || undefined,
			callbackUrl,
			redirectUrl: callbackUrl,
			state: bridge?.state || "",
			authMode: "oauth_callback",
			authStatus: "pending",
			authorizationUrlSupported: Boolean(authorizationUrl),
			tokenExchangeSupported: bridge?.tokenExchangeSupported === true,
			message:
				authorizationUrl
					? `${providerAuthLabel(provider)} OAuth authorization URL opened. Complete sign-in in the browser and return to LIG VS through the localhost callback.`
					: `${providerAuthLabel(provider)} OAuth callback bridge is ready. Configure a provider authorization URL to open sign-in automatically.`,
		}
	}

	return createVisualStudioAuthUnsupportedResponse(provider)
}

export function isOAuthBridgeProvider(provider: string) {
	const normalized = normalizeProviderValue(provider)
	const compact = String(provider || "").replace(/[_\s-]/g, "").toLowerCase()
	return normalized === "oca" || normalized === "openai-codex" || normalized === "account" || compact === "openaicodex"
}

export function createOAuthAuthorizationRequest(provider: string, callbackUrl: string, state: string, request: Record<string, unknown>) {
	const authorizationBaseUrl = getString(request, "authorizationUrl") || getString(request, "authUrl") || oauthProviderEnv(provider, "AUTHORIZE_URL")
	const clientId = getString(request, "clientId") || oauthProviderEnv(provider, "CLIENT_ID")
	const scope = getString(request, "scope") || oauthProviderEnv(provider, "SCOPE")
	const audience = getString(request, "audience") || oauthProviderEnv(provider, "AUDIENCE")
	const tokenExchange = createOAuthTokenExchangeConfig(provider, request)
	const tokenExchangeSupported = Boolean(tokenExchange)
	if (!authorizationBaseUrl) {
		return { url: "", tokenExchangeSupported, tokenExchange }
	}

	try {
		const url = new URL(authorizationBaseUrl)
		if (!url.searchParams.has("response_type")) {
			url.searchParams.set("response_type", "code")
		}
		if (clientId && !url.searchParams.has("client_id")) {
			url.searchParams.set("client_id", clientId)
		}
		if (!url.searchParams.has("redirect_uri")) {
			url.searchParams.set("redirect_uri", callbackUrl)
		}
		if (!url.searchParams.has("state")) {
			url.searchParams.set("state", state)
		}
		if (scope && !url.searchParams.has("scope")) {
			url.searchParams.set("scope", scope)
		}
		if (audience && !url.searchParams.has("audience")) {
			url.searchParams.set("audience", audience)
		}
		return { url: url.toString(), tokenExchangeSupported, tokenExchange }
	} catch {
		return { url: "", tokenExchangeSupported, tokenExchange }
	}
}

export function createOAuthTokenExchangeConfig(provider: string, request: Record<string, unknown>): OAuthTokenExchangeConfig | null {
	const tokenUrl = getString(request, "tokenUrl") || getString(request, "tokenEndpoint") || oauthProviderEnv(provider, "TOKEN_URL")
	const clientId = getString(request, "clientId") || oauthProviderEnv(provider, "CLIENT_ID")
	if (!tokenUrl || !clientId) {
		return null
	}

	return {
		tokenUrl,
		clientId,
		clientSecret: getString(request, "clientSecret") || oauthProviderEnv(provider, "CLIENT_SECRET") || undefined,
		scope: getString(request, "scope") || oauthProviderEnv(provider, "SCOPE") || undefined,
		codeVerifier: getString(request, "codeVerifier") || getString(request, "code_verifier") || oauthProviderEnv(provider, "CODE_VERIFIER") || undefined,
		authMethod: getString(request, "authMethod") || oauthProviderEnv(provider, "AUTH_METHOD") || undefined,
	}
}

export function parseUrlFragmentParams(url: URL) {
	const fragment = url.hash.replace(/^#/, "")
	return new URLSearchParams(fragment)
}

export function hasConfiguredOAuthAuthorizationUrl(provider: string, request: Record<string, unknown> = {}) {
	return Boolean(getString(request, "authorizationUrl") || getString(request, "authUrl") || oauthProviderEnv(provider, "AUTHORIZE_URL"))
}

export function hasConfiguredOAuthTokenExchange(provider: string, request: Record<string, unknown> = {}) {
	return Boolean(createOAuthTokenExchangeConfig(provider, request))
}

export function oauthProviderEnv(provider: string, suffix: string) {
	const normalized = normalizeProviderValue(provider) || String(provider || "account")
	const envKey = normalized.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
	return process.env[`VSCLINE_${envKey}_OAUTH_${suffix}`] || process.env[`LIGVS_${envKey}_OAUTH_${suffix}`] || process.env[`VSCLINE_OAUTH_${suffix}`] || ""
}

export function redactUrl(value: string) {
	try {
		const url = new URL(value)
		url.search = ""
		url.hash = ""
		return url.toString()
	} catch {
		return value ? "[configured]" : ""
	}
}

export function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;"
			case "<":
				return "&lt;"
			case ">":
				return "&gt;"
			case '"':
				return "&quot;"
			case "'":
				return "&#39;"
			default:
				return char
		}
	})
}

export function normalizeHttpUrl(value: string) {
	const raw = String(value || "").trim()
	if (!raw) {
		return ""
	}
	try {
		return new URL(raw).toString()
	} catch {
		try {
			return new URL(`https://${raw}`).toString()
		} catch {
			return ""
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
