import type { OAuthAuthorizationCodeRequest, OAuthTokenResult } from "../dto/OAuthContracts"

export interface OAuthTokenExchangePort {
	exchangeAuthorizationCode(request: OAuthAuthorizationCodeRequest): Promise<OAuthTokenResult>
}
