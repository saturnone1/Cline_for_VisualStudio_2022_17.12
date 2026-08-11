import { providerAuthLabel } from "../../application/services/ProviderIdentity"
import type { OAuthCallbackSession } from "./OAuthCallbackCoordinator"
import { isOAuthBridgeProvider } from "./ProviderCredentialPolicy"

export function createUnauthenticatedAccountState() { return { loggedIn: false, user: null, organizations: [], activeOrganization: null, isAuthenticated: false, openAiCodexIsAuthenticated: false, authStatus: "unauthenticated" } }

export function createVisualStudioAuthUnsupportedResponse(provider: string, url = "") {
	return { success: false, supported: false, provider, url, value: url, message: `${providerAuthLabel(provider)} OAuth is not implemented in the Visual Studio 2022 host yet. Use a local API key or a provider-specific credential file where available.`, reason: "visual_studio_oauth_callback_not_implemented", ...createUnauthenticatedAccountState() }
}

export function createProviderAuthInfo(provider: string, message: unknown, bridge: OAuthCallbackSession | null = null) {
	const request = asRecord(message)
	if (provider === "openrouter") return { success: true, supported: true, provider, url: "https://openrouter.ai/settings/keys", value: "https://openrouter.ai/settings/keys", message: "OpenRouter API key page opened. Paste the generated key into LIG VS settings.", authMode: "api_key" }
	if (provider === "requesty") { const configured = readString(request.value) || readString(request.baseUrl); const root = normalizeHttpUrl(configured) || "https://app.requesty.ai"; const url = new URL("api-keys", root.endsWith("/") ? root : `${root}/`).toString(); return { success: true, supported: true, provider, url, value: url, message: "Requesty API key page opened. Paste the generated key into LIG VS settings.", authMode: "api_key" } }
	if (provider === "hicap") return { success: true, supported: true, provider, url: "https://hicap.ai", value: "https://hicap.ai", message: "Hicap provider page opened. Use a local API key in LIG VS settings.", authMode: "api_key" }
	if (bridge || isOAuthBridgeProvider(provider)) {
		const callbackUrl = bridge?.callbackUrl || "", authorizationUrl = bridge?.authorizationUrl || ""
		return { ...createUnauthenticatedAccountState(), success: true, supported: true, provider, value: authorizationUrl || callbackUrl, url: authorizationUrl || undefined, authorizationUrl: authorizationUrl || undefined, callbackUrl, redirectUrl: callbackUrl, state: bridge?.state || "", authMode: "oauth_callback", authStatus: "pending", authorizationUrlSupported: Boolean(authorizationUrl), tokenExchangeSupported: bridge?.tokenExchangeSupported === true, message: authorizationUrl ? `${providerAuthLabel(provider)} OAuth authorization URL opened. Complete sign-in in the browser and return to LIG VS through the localhost callback.` : `${providerAuthLabel(provider)} OAuth callback bridge is ready. Configure a provider authorization URL to open sign-in automatically.` }
	}
	return createVisualStudioAuthUnsupportedResponse(provider)
}

function normalizeHttpUrl(value: string) { if (!value) return ""; try { const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`; return new URL(candidate).toString() } catch { return "" } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
