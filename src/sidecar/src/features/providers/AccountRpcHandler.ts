import { extractProviderCredentialValue, isOAuthBridgeProvider } from "./ProviderCredentialPolicy"
import { createUnauthenticatedAccountState, createVisualStudioAuthUnsupportedResponse } from "./ProviderAuthActionPolicy"
import type { OAuthAuthorizationHandler } from "./OAuthAuthorizationHandler"
import type { OAuthCallbackHandler } from "./OAuthCallbackHandler"
import type { ProviderAuthActionHandler } from "./ProviderAuthActionHandler"
import type { ProviderCredentialHandler, ProviderCredentialMutation } from "./ProviderCredentialHandler"

type Payload = Record<string, unknown>

export type AccountCommand =
	| Readonly<{ type: "redirectUrl"; request: Payload }>
	| Readonly<{ type: "organizations" }>
	| Readonly<{ type: "credits" }>
	| Readonly<{ type: "unsupportedAccountMutation" }>
	| Readonly<{ type: "login"; provider: string; request: Payload; clearCodexBefore?: boolean }>
	| Readonly<{ type: "logout"; provider: "account" | "openai-codex" | "oca" }>
	| Readonly<{ type: "saveCredential"; request: Payload }>
	| Readonly<{ type: "credentialStatus"; request: Payload }>
	| Readonly<{ type: "refreshCredential"; request: Payload }>
	| Readonly<{ type: "providerFields"; request: Payload }>
	| Readonly<{ type: "callbackStatus"; request: Payload }>
	| Readonly<{ type: "submitCallback"; request: Payload }>
	| Readonly<{ type: "clearCredential"; request: Payload }>

export type AccountRpcResult = Readonly<{ payload: Payload; includeStateMessages?: boolean }>

type Callbacks = Readonly<{
	authorization: () => OAuthAuthorizationHandler
	callback: () => OAuthCallbackHandler
	authActions: () => ProviderAuthActionHandler
	credentials: () => ProviderCredentialHandler
	configuration: () => Payload
	mutateConfiguration: (updates: Readonly<Record<string, unknown>>, deletes: readonly string[]) => void
	syncProfiles: () => void
	setCodexAuthenticated: (authenticated: boolean) => void
	persist: () => void
	broadcast: () => Promise<void>
	log: (event: string, details: unknown) => void
}>

export class AccountRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: AccountCommand): Promise<AccountRpcResult> {
		switch (command.type) {
			case "redirectUrl": return { payload: await this.createCallbackBridge(command.request, "account") }
			case "organizations": return { payload: { organizations: [] } }
			case "credits": return { payload: { credits: 0, balance: 0, value: 0 } }
			case "unsupportedAccountMutation": return { payload: createVisualStudioAuthUnsupportedResponse("account") }
			case "login":
				if (command.clearCodexBefore) {
					this.callbacks.setCodexAuthenticated(false)
					await this.callbacks.broadcast()
				}
				return { payload: await this.handleAuthAction(command.provider, command.request) }
			case "logout": return this.logout(command.provider)
			case "saveCredential": return { payload: await this.apply(this.callbacks.credentials().save(command.request)), includeStateMessages: true }
			case "credentialStatus": return { payload: this.callbacks.credentials().status(command.request, this.callbacks.configuration()) }
			case "refreshCredential": return { payload: await this.apply(await this.callbacks.credentials().refresh(command.request, this.callbacks.configuration())), includeStateMessages: true }
			case "providerFields": return { payload: await this.callbacks.credentials().getConfigFields(command.request, this.callbacks.configuration()) }
			case "callbackStatus": return { payload: this.callbacks.callback().status(command.request) }
			case "submitCallback": return { payload: await this.callbacks.callback().submit(command.request, (mutation) => this.apply(mutation)), includeStateMessages: true }
			case "clearCredential": return { payload: await this.apply(this.callbacks.credentials().clear(command.request)), includeStateMessages: true }
		}
	}

	async receiveCallback(url: string) {
		const result = await this.callbacks.callback().receive(url, (mutation) => this.apply(mutation))
		await this.callbacks.broadcast().catch(() => undefined)
		return result
	}

	private async handleAuthAction(provider: string, request: Payload) {
		const credential = extractProviderCredentialValue(request)
		if (credential) return this.apply(this.callbacks.credentials().save({ ...request, provider, value: credential, source: "auth_action" }))
		const bridge = isOAuthBridgeProvider(provider)
			? await this.callbacks.authorization().ensure(provider, request, (url) => this.receiveCallback(url))
			: null
		const response = await this.callbacks.authActions().execute(provider, request, bridge)
		if (provider === "openAiCodex") {
			this.callbacks.setCodexAuthenticated(false)
			await this.callbacks.broadcast()
		}
		return response
	}

	private async createCallbackBridge(request: Payload, fallbackProvider: string) {
		const provider = readString(request.provider) || readString(request.providerId) || fallbackProvider
		const bridge = await this.callbacks.authorization().ensure(provider, request, (url) => this.receiveCallback(url))
		return this.callbacks.authorization().response(bridge)
	}

	private async logout(provider: "account" | "openai-codex" | "oca"): Promise<AccountRpcResult> {
		if (provider === "oca") return { payload: createUnauthenticatedAccountState() }
		this.callbacks.setCodexAuthenticated(false)
		if (provider === "account") await this.apply(this.callbacks.credentials().clear({ provider: "account" }))
		await this.apply(this.callbacks.credentials().clear({ provider: "openai-codex" }))
		return { payload: createUnauthenticatedAccountState(), includeStateMessages: provider === "openai-codex" }
	}

	private async apply(mutation: ProviderCredentialMutation) {
		if (mutation.updates || mutation.deletes?.length || mutation.openAiCodexAuthenticated !== undefined) {
			this.callbacks.mutateConfiguration(mutation.updates || {}, mutation.deletes || [])
			if (mutation.openAiCodexAuthenticated !== undefined) this.callbacks.setCodexAuthenticated(mutation.openAiCodexAuthenticated)
			this.callbacks.syncProfiles()
			this.callbacks.persist()
			await this.callbacks.broadcast()
		}
		if (mutation.log) this.callbacks.log(mutation.log.event, { ...mutation.log.details })
		return { ...mutation.response }
	}
}

function readString(value: unknown) { return typeof value === "string" ? value : "" }
