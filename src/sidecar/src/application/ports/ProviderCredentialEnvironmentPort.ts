import type { OAuthTokenExchangeConfig } from "../dto/OAuthContracts"

export interface ProviderCredentialEnvironmentPort {
	readonly oauthExpirySkewMs: number
	resolveApiKey(provider: string): string
	resolveBaseUrl(provider: string): string
	createTokenExchangeConfig(provider: string, request: Readonly<Record<string, unknown>>): OAuthTokenExchangeConfig | null
}
