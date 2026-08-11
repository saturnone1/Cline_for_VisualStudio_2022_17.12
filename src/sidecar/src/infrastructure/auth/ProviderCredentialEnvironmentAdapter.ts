import type { ProviderCredentialEnvironmentPort } from "../../application/ports/ProviderCredentialEnvironmentPort"
import { resolveProviderEnvApiKey, resolveProviderEnvBaseUrl } from "../configuration/ProviderConfiguration"
import { createOAuthTokenExchangeConfig, hasConfiguredOAuthAuthorizationUrl } from "./ProviderAuthSupport"

export class ProviderCredentialEnvironmentAdapter implements ProviderCredentialEnvironmentPort {
	get oauthExpirySkewMs() { const value = Number(process.env.VSCLINE_OAUTH_EXPIRY_SKEW_MS); return Number.isFinite(value) && value > 0 ? Math.floor(value) : 60_000 }
	resolveApiKey(provider: string) { return resolveProviderEnvApiKey(provider) }
	resolveBaseUrl(provider: string) { return resolveProviderEnvBaseUrl(provider) }
	createTokenExchangeConfig(provider: string, request: Readonly<Record<string, unknown>>) { return createOAuthTokenExchangeConfig(provider, { ...request }) }
	hasAuthorizationUrl(provider: string, request: Readonly<Record<string, unknown>> = {}) { return hasConfiguredOAuthAuthorizationUrl(provider, { ...request }) }
}
