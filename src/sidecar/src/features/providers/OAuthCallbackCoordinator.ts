import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import { normalizeProviderValue } from "../../application/services/ProviderIdentity"
import type { OAuthTokenExchangeConfig } from "../../application/dto/OAuthContracts"

export type OAuthCallbackSession = {
	provider: string
	state: string
	callbackUrl: string
	authorizationUrl?: string
	createdAt: number
	status: "pending" | "received" | "configured" | "error"
	code?: string
	token?: string
	refreshToken?: string
	tokenType?: string
	expiresAt?: number
	error?: string
	message?: string
	rawQuery?: Record<string, string>
	tokenExchangeSupported?: boolean
	tokenExchange?: OAuthTokenExchangeConfig
	tokenResponse?: Record<string, unknown>
}

export class OAuthCallbackCoordinator {
	private readonly sessions = new Map<string, OAuthCallbackSession>()

	constructor(private readonly logger: InteractionLoggerPort, private readonly ttlMs = 15 * 60 * 1000) {}

	register(session: OAuthCallbackSession) {
		this.prune()
		this.sessions.set(session.state, session)
		return session
	}

	find(state: string, provider = "") {
		return (state && this.sessions.get(state)) || this.latest(provider)
	}

	latest(provider: string) {
		const normalized = normalizeProviderValue(provider) || "account"
		return Array.from(this.sessions.values()).filter((session) => session.provider === normalized).sort((left, right) => right.createdAt - left.createdAt)[0]
	}

	record(callbackUrl: string) {
		let url: URL
		try { url = new URL(callbackUrl) } catch { return { success: false, message: "OAuth callback URL is invalid." } }
		const hash = new URLSearchParams(url.hash.replace(/^#/, ""))
		const state = url.searchParams.get("state") || hash.get("state") || ""
		const provider = normalizeProviderValue(url.searchParams.get("provider") || hash.get("provider") || "") || "account"
		const session = this.find(state, provider)
		if (!session) return { success: false, message: "No matching LIG VS OAuth callback request is pending." }
		const code = url.searchParams.get("code") || hash.get("code") || ""
		const token = first(url.searchParams, hash, ["access_token", "token", "api_key", "key"])
		const error = url.searchParams.get("error") || hash.get("error") || ""
		session.status = error ? "error" : "received"
		session.code = code || undefined
		session.token = token || undefined
		session.error = error || undefined
		session.rawQuery = { ...Object.fromEntries(url.searchParams.entries()), ...Object.fromEntries(hash.entries()) }
		session.message = error ? `OAuth callback failed: ${error}` : token ? "OAuth callback received a token. Credential storage will use the provider API-key field when available." : code ? "OAuth callback received an authorization code. Provider-specific token exchange is still required." : "OAuth callback was received, but it did not include a code or token."
		this.logger.log("sidecar", "oauthCallbackReceived", { provider: session.provider, state: session.state, status: session.status, hasCode: Boolean(code), hasToken: Boolean(token), error: error || undefined })
		return { success: true, provider: session.provider, state: session.state, message: session.message, session }
	}

	status(provider: string, state = "") {
		const normalized = normalizeProviderValue(provider) || "account"
		const session = this.find(state, normalized)
		if (!session) return { success: false, provider: normalized, authStatus: "unauthenticated", message: "No OAuth callback request is pending for this provider." }
		return { success: true, provider: session.provider, state: session.state, callbackUrl: session.callbackUrl, authorizationUrl: session.authorizationUrl || undefined, redirectUrl: session.callbackUrl, authStatus: session.status, hasCode: Boolean(session.code), hasToken: Boolean(session.token), error: session.error || undefined, message: session.message || "", tokenExchangeSupported: session.tokenExchangeSupported === true }
	}

	prune(now = Date.now()) {
		const cutoff = now - this.ttlMs
		for (const [state, session] of this.sessions) if (session.createdAt < cutoff) this.sessions.delete(state)
	}
}

function first(query: URLSearchParams, hash: URLSearchParams, keys: string[]) { for (const key of keys) { const value = query.get(key) || hash.get(key); if (value) return value } return "" }
