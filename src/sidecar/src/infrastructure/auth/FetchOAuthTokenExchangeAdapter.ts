import type { OAuthAuthorizationCodeRequest, OAuthTokenResult } from "../../application/dto/OAuthContracts"
import type { OAuthTokenExchangePort } from "../../application/ports/OAuthTokenExchangePort"

export class FetchOAuthTokenExchangeAdapter implements OAuthTokenExchangePort {
	async exchangeAuthorizationCode(request: OAuthAuthorizationCodeRequest): Promise<OAuthTokenResult> {
		const body = new URLSearchParams({ grant_type: "authorization_code", code: request.code, redirect_uri: request.redirectUri, client_id: request.clientId })
		if (request.clientSecret && request.authMethod !== "client_secret_basic") body.set("client_secret", request.clientSecret)
		if (request.scope) body.set("scope", request.scope)
		if (request.codeVerifier) body.set("code_verifier", request.codeVerifier)
		const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
		if (request.clientSecret && request.authMethod === "client_secret_basic") headers.authorization = `Basic ${Buffer.from(`${request.clientId}:${request.clientSecret}`).toString("base64")}`
		const response = await fetch(request.tokenUrl, { method: "POST", headers, body })
		const text = await response.text()
		const parsed = parseRecord(text)
		if (!response.ok) {
			const detail = readString(parsed.error_description) || readString(parsed.error) || text.slice(0, 500)
			throw new Error(`Token endpoint returned HTTP ${response.status}: ${detail || response.statusText}`)
		}
		const accessToken = readString(parsed.access_token) || readString(parsed.token)
		if (!accessToken) throw new Error("Token endpoint response did not include access_token.")
		const expiresIn = readNumber(parsed.expires_in)
		return { accessToken, refreshToken: readString(parsed.refresh_token) || undefined, tokenType: readString(parsed.token_type) || undefined, expiresIn: expiresIn || undefined, rawResponse: parsed }
	}
}

function parseRecord(text: string): Record<string, unknown> { try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : {} } catch { return {} } }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function readNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
