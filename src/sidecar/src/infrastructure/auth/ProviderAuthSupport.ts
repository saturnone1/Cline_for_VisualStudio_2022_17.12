import { createId } from "../conversation/TaskHistoryProjection"
import {
	type OAuthTokenExchangeConfig,
	resolveProviderEnvApiKey,
	resolveProviderEnvBaseUrl,
} from "../configuration/ProviderConfiguration"
import {
	isOAuthTokenBlobProvider,
	normalizeProviderValue,
	oauthCredentialsField,
} from "../../application/services/ProviderIdentity"
import type { OAuthCallbackSession } from "../../features/providers/OAuthCallbackCoordinator"
export type { OAuthCallbackSession } from "../../features/providers/OAuthCallbackCoordinator"
import { createFallbackProviderConfigFields, isOAuthBridgeProvider } from "../../features/providers/ProviderCredentialPolicy"
export { createFallbackProviderConfigFields, isOAuthBridgeProvider } from "../../features/providers/ProviderCredentialPolicy"
export { createProviderAuthInfo, createUnauthenticatedAccountState, createVisualStudioAuthUnsupportedResponse } from "../../features/providers/ProviderAuthActionPolicy"

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

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
