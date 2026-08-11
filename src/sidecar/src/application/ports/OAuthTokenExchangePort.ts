import type { OAuthAuthorizationCodeRequest, OAuthRefreshTokenRequest, OAuthTokenResult } from "../dto/OAuthContracts"

export interface OAuthTokenExchangePort {
	exchangeAuthorizationCode(request: OAuthAuthorizationCodeRequest): Promise<OAuthTokenResult>
	refreshAccessToken(request: OAuthRefreshTokenRequest): Promise<OAuthTokenResult>
}
