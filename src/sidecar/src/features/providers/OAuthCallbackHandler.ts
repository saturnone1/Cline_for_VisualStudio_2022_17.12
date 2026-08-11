import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import { normalizeProviderValue } from "../../application/services/ProviderIdentity"
import { OAuthCallbackCoordinator, type OAuthCallbackSession } from "./OAuthCallbackCoordinator"
import type { OAuthTokenHandler } from "./OAuthTokenHandler"
import type { ProviderCredentialHandler, ProviderCredentialMutation } from "./ProviderCredentialHandler"

type ApplyCredentialMutation = (mutation: ProviderCredentialMutation) => Promise<Readonly<Record<string, unknown>>>

export class OAuthCallbackHandler {
	constructor(
		private readonly callbacks: OAuthCallbackCoordinator,
		private readonly tokens: OAuthTokenHandler,
		private readonly credentials: ProviderCredentialHandler,
		private readonly logger: InteractionLoggerPort,
	) {}

	status(message: unknown) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(readString(request.provider) || readString(request.providerId) || "account")
		return this.callbacks.status(provider, readString(request.state))
	}

	async receive(url: string, applyMutation: ApplyCredentialMutation) {
		const result = this.callbacks.record(url)
		if (result.success && result.session) {
			await this.complete(result.session, applyMutation).catch((error) => this.recordCompletionError(result.session!, error))
		}
		return { success: result.success, message: result.message }
	}

	async submit(message: unknown, applyMutation: ApplyCredentialMutation) {
		const request = asRecord(message)
		const callbackUrl = readString(request.callbackUrl) || readString(request.url) || readString(request.value)
		if (!callbackUrl) return { success: false, message: "OAuth callback URL is required.", authStatus: "unknown" }

		let parsedUrl: URL
		try { parsedUrl = new URL(callbackUrl) } catch { return { success: false, message: "OAuth callback URL is invalid.", authStatus: "unknown" } }
		const result = this.callbacks.record(parsedUrl.toString())
		const hash = new URLSearchParams(parsedUrl.hash.replace(/^#/, ""))
		const provider = normalizeProviderValue(parsedUrl.searchParams.get("provider") || hash.get("provider") || readString(request.provider) || "account")
		const session = result.session || this.callbacks.latest(provider)
		if (result.success && session) {
			const completion = await this.complete(session, applyMutation)
			return {
				...this.callbacks.status(provider, session.state),
				...completion,
				success: typeof completion.success === "boolean" ? completion.success : result.success,
				message: readString(completion.message) || result.message,
			}
		}
		return { ...this.callbacks.status(provider, session?.state), success: result.success, message: result.message }
	}

	private async complete(session: OAuthCallbackSession, applyMutation: ApplyCredentialMutation) {
		if (session.status === "error") return { success: false, message: session.message || session.error || "OAuth callback failed." }
		if (!session.token && session.code && session.tokenExchange) await this.tokens.exchangeAuthorizationCode(session)
		if (!session.token) return { success: false, provider: session.provider, authStatus: session.status, message: session.message || "OAuth callback did not provide a token." }

		const response = await applyMutation(this.credentials.persistOAuthSession(session))
		if (response.success === true) {
			session.status = "configured"
			session.message = readString(response.message) || "OAuth credential was saved."
		}
		return response
	}

	private recordCompletionError(session: OAuthCallbackSession, error: unknown) {
		session.status = "error"
		session.error = error instanceof Error ? error.message : String(error)
		session.message = `OAuth token exchange failed: ${session.error}`
		this.logger.log("sidecar", "oauthTokenExchangeFailed", { provider: session.provider, state: session.state, error: session.error })
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
