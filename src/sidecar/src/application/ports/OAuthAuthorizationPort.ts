import type { OAuthTokenExchangeConfig } from "../dto/OAuthContracts"

export type OAuthAuthorizationRequest = Readonly<{
	url: string
	tokenExchangeSupported: boolean
	tokenExchange?: OAuthTokenExchangeConfig
}>

export interface OAuthAuthorizationPort {
	create(provider: string, callbackUrl: string, state: string, request: Record<string, unknown>): OAuthAuthorizationRequest
}
