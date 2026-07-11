import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { OAuthTokenExchangePort } from "../../application/ports/OAuthTokenExchangePort"
import type { OAuthCallbackSession } from "./OAuthCallbackCoordinator"

export class OAuthTokenHandler {
	constructor(private readonly exchange: OAuthTokenExchangePort, private readonly logger: InteractionLoggerPort) {}

	async exchangeAuthorizationCode(session: OAuthCallbackSession) {
		if (!session.code || !session.tokenExchange) return session
		const config = session.tokenExchange
		this.logger.log("sidecar", "oauthTokenExchangeStarted", { provider: session.provider, state: session.state, tokenUrl: redactUrl(config.tokenUrl), authMethod: config.authMethod || "client_secret_post" })
		const result = await this.exchange.exchangeAuthorizationCode({ ...config, code: session.code, redirectUri: session.callbackUrl })
		session.token = result.accessToken
		session.refreshToken = result.refreshToken
		session.tokenType = result.tokenType
		session.expiresAt = result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined
		session.tokenResponse = { ...result.rawResponse }
		session.status = "received"
		session.message = "OAuth token exchange completed. Saving credential for LIG VS."
		this.logger.log("sidecar", "oauthTokenExchangeCompleted", { provider: session.provider, state: session.state, hasRefreshToken: Boolean(session.refreshToken), expiresIn: result.expiresIn || undefined })
		return session
	}
}

function redactUrl(value: string) { try { const url = new URL(value); url.search = ""; url.hash = ""; return url.toString() } catch { return value ? "[configured]" : "" } }
