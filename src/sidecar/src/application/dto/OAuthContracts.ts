export type OAuthTokenExchangeConfig = Readonly<{
	tokenUrl: string
	clientId: string
	clientSecret?: string
	scope?: string
	codeVerifier?: string
	authMethod?: string
}>

export type OAuthAuthorizationCodeRequest = Readonly<OAuthTokenExchangeConfig & {
	code: string
	redirectUri: string
}>

export type OAuthTokenResult = Readonly<{
	accessToken: string
	refreshToken?: string
	tokenType?: string
	expiresIn?: number
	rawResponse: Readonly<Record<string, unknown>>
}>
