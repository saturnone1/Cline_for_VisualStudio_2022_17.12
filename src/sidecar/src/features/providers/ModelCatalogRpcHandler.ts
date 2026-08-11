export type ProviderCatalogRequest = Readonly<{ baseUrl: string; apiConfigurationUpdate: Record<string, unknown> }>

export type ModelCatalogCommand =
	| Readonly<{ type: "ollamaValues"; baseUrl: string }>
	| Readonly<{ type: "lmStudioValues"; baseUrl: string }>
	| Readonly<{ type: "refresh"; providerId: string; request: ProviderCatalogRequest }>
	| Readonly<{ type: "askSage"; baseUrl: string }>
	| Readonly<{ type: "openRouterKeyInfo"; apiKey: string }>
	| Readonly<{ type: "unsupported"; key: string }>

type Callbacks = Readonly<{
	ollamaValues: (baseUrl: string, signal?: AbortSignal) => Promise<unknown>
	lmStudioValues: (baseUrl: string, signal?: AbortSignal) => Promise<unknown>
	refresh: (providerId: string, request: ProviderCatalogRequest, signal?: AbortSignal) => Promise<unknown>
	askSage: (baseUrl: string, signal?: AbortSignal) => Promise<unknown>
	openRouterKeyInfo: (apiKey: string, signal?: AbortSignal) => Promise<unknown>
	unsupported: (key: string) => unknown
}>

export class ModelCatalogRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	handle(command: ModelCatalogCommand, signal?: AbortSignal): unknown | Promise<unknown> {
		switch (command.type) {
			case "ollamaValues": return this.callbacks.ollamaValues(command.baseUrl, signal)
			case "lmStudioValues": return this.callbacks.lmStudioValues(command.baseUrl, signal)
			case "refresh": return this.callbacks.refresh(command.providerId, command.request, signal)
			case "askSage": return this.callbacks.askSage(command.baseUrl, signal)
			case "openRouterKeyInfo": return this.callbacks.openRouterKeyInfo(command.apiKey, signal)
			case "unsupported": return this.callbacks.unsupported(command.key)
		}
	}
}
