import type { AccountCommand } from "../../features/providers/AccountRpcHandler"

export function decodeAccountRpcCommand(key: string, message: unknown): AccountCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "AccountService.getRedirectUrl": return { type: "redirectUrl", request }
		case "AccountService.getUserOrganizations": return { type: "organizations" }
		case "AccountService.getUserCredits":
		case "AccountService.getOrganizationCredits": return { type: "credits" }
		case "AccountService.setUserOrganization":
		case "AccountService.submitLimitIncreaseRequest": return { type: "unsupportedAccountMutation" }
		case "AccountService.accountLoginClicked": return { type: "login", provider: "account", request: {} }
		case "AccountService.accountLogoutClicked": return { type: "logout", provider: "account" }
		case "AccountService.openrouterAuthClicked": return { type: "login", provider: "openrouter", request }
		case "AccountService.requestyAuthClicked": return { type: "login", provider: "requesty", request }
		case "AccountService.hicapAuthClicked": return { type: "login", provider: "hicap", request }
		case "AccountService.openAiCodexSignIn": return { type: "login", provider: "openAiCodex", request, clearCodexBefore: true }
		case "AccountService.openAiCodexSignOut": return { type: "logout", provider: "openai-codex" }
		case "AccountService.saveProviderCredential":
		case "AccountService.storeProviderCredential":
		case "AccountService.saveProviderToken": return { type: "saveCredential", request }
		case "AccountService.getProviderCredentialStatus":
		case "AccountService.getProviderAuthStatus": return { type: "credentialStatus", request }
		case "AccountService.refreshProviderCredential":
		case "AccountService.refreshProviderToken":
		case "AccountService.refreshOAuthCredential": return { type: "refreshCredential", request }
		case "AccountService.getProviderConfigFields":
		case "AccountService.getProviderAuthRequirements": return { type: "providerFields", request }
		case "AccountService.getOAuthCallbackStatus":
		case "AccountService.getProviderOAuthCallbackStatus": return { type: "callbackStatus", request }
		case "AccountService.submitOAuthCallback":
		case "AccountService.completeOAuthCallback":
		case "AccountService.saveOAuthCallback": return { type: "submitCallback", request }
		case "AccountService.clearProviderCredential":
		case "AccountService.deleteProviderCredential":
		case "AccountService.clearProviderToken": return { type: "clearCredential", request }
		case "OcaAccountService.ocaAccountLoginClicked": return { type: "login", provider: "oca", request }
		case "OcaAccountService.ocaAccountLogoutClicked": return { type: "logout", provider: "oca" }
		default: return undefined
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
