export type OAuthTokenExchangeConfig = Readonly<{
	tokenUrl: string
	clientId: string
	clientSecret?: string
	scope?: string
	codeVerifier?: string
	authMethod?: string
}>
