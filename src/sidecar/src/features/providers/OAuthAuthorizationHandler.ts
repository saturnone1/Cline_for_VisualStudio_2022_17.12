import type { OAuthAuthorizationPort } from "../../application/ports/OAuthAuthorizationPort"
import type { OAuthCallbackHttpHandler, OAuthCallbackListenerPort } from "../../application/ports/OAuthCallbackListenerPort"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import { normalizeProviderValue, providerAuthLabel } from "../../application/services/ProviderIdentity"
import { OAuthCallbackCoordinator, type OAuthCallbackSession } from "./OAuthCallbackCoordinator"

export class OAuthAuthorizationHandler {
	private callbackPort = 0

	constructor(
		private readonly callbacks: OAuthCallbackCoordinator,
		private readonly listener: OAuthCallbackListenerPort,
		private readonly authorization: OAuthAuthorizationPort,
		private readonly logger: InteractionLoggerPort,
		private readonly createId: () => string,
	) {}

	async ensure(provider: string, request: Record<string, unknown>, callback: OAuthCallbackHttpHandler): Promise<OAuthCallbackSession> {
		this.callbacks.prune()
		if (!this.callbackPort) {
			this.callbackPort = await this.listener.start(callback)
			this.logger.log("sidecar", "oauthCallbackServerListening", { port: this.callbackPort })
		}

		const normalizedProvider = normalizeProviderValue(provider) || "account"
		const state = this.createId()
		const callbackUrl = `http://127.0.0.1:${this.callbackPort}/oauth/callback?provider=${encodeURIComponent(normalizedProvider)}&state=${encodeURIComponent(state)}`
		const authorization = this.authorization.create(normalizedProvider, callbackUrl, state, request)
		const session = this.callbacks.register({
			provider: normalizedProvider,
			state,
			callbackUrl,
			authorizationUrl: authorization.url || undefined,
			createdAt: Date.now(),
			status: "pending",
			tokenExchangeSupported: authorization.tokenExchangeSupported,
			tokenExchange: authorization.tokenExchange,
			message: authorization.url ? "Waiting for OAuth provider authorization and redirect." : "Waiting for OAuth provider redirect.",
		})
		this.logger.log("sidecar", "oauthCallbackBridgeReady", {
			provider: normalizedProvider,
			state,
			port: this.callbackPort,
			hasAuthorizationUrl: Boolean(authorization.url),
			tokenExchangeSupported: authorization.tokenExchangeSupported,
		})
		return session
	}

	response(session: OAuthCallbackSession) {
		return {
			success: true,
			supported: true,
			provider: session.provider,
			value: session.authorizationUrl || session.callbackUrl,
			url: session.authorizationUrl || undefined,
			authorizationUrl: session.authorizationUrl || undefined,
			redirectUrl: session.callbackUrl,
			callbackUrl: session.callbackUrl,
			state: session.state,
			authStatus: "pending",
			tokenExchangeSupported: session.tokenExchangeSupported === true,
			message: session.authorizationUrl
				? `${providerAuthLabel(session.provider)} OAuth authorization URL is ready. Complete sign-in in the browser and return to LIG VS through the localhost callback.`
				: `${providerAuthLabel(session.provider)} OAuth callback bridge is ready. Configure a provider authorization URL to open sign-in automatically.`,
		}
	}

	dispose() { this.listener.dispose() }
}
