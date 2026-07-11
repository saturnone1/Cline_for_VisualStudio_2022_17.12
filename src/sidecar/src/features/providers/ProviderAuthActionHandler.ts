import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { ProviderAuthUiPort } from "../../application/ports/ProviderAuthUiPort"
import type { OAuthCallbackSession } from "./OAuthCallbackCoordinator"
import { createProviderAuthInfo, createUnauthenticatedAccountState } from "./ProviderAuthActionPolicy"

export class ProviderAuthActionHandler {
	constructor(private readonly ui: ProviderAuthUiPort, private readonly logger: InteractionLoggerPort) {}

	async execute(provider: string, message: unknown, bridge: OAuthCallbackSession | null) {
		const authInfo = createProviderAuthInfo(provider, message, bridge)
		if (authInfo.url) await this.ui.openExternal(authInfo.url)
		if (authInfo.message) await this.ui.showMessage(authInfo.message, authInfo.supported ? "info" : "warning")
		this.logger.log("sidecar", "accountAuthAction", { provider, supported: authInfo.supported, url: authInfo.url || undefined, reason: readString((authInfo as Record<string, unknown>).reason) || undefined })
		return { ...createUnauthenticatedAccountState(), ...authInfo }
	}
}

function readString(value: unknown) { return typeof value === "string" ? value : "" }
