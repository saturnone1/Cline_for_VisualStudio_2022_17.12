export interface ProviderAuthUiPort {
	openExternal(url: string): Promise<void>
	showMessage(message: string, type: "info" | "warning"): Promise<void>
}
