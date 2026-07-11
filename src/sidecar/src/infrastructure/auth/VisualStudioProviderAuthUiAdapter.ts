import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { ProviderAuthUiPort } from "../../application/ports/ProviderAuthUiPort"

export class VisualStudioProviderAuthUiAdapter implements ProviderAuthUiPort {
	constructor(private readonly host: HostProviderPort) {}
	async openExternal(url: string) { await this.host.envClient.openExternal({ value: url }) }
	async showMessage(message: string, type: "info" | "warning") { await this.host.windowClient.showMessage({ message, type }) }
}
