export type ProviderCatalogRequest = Readonly<{ baseUrl: string; apiConfigurationUpdate: Record<string, unknown> }>

export type ModelCatalogCommand =
	| Readonly<{ type: "ollamaValues"; baseUrl: string }>
	| Readonly<{ type: "lmStudioValues"; baseUrl: string }>
	| Readonly<{ type: "refresh"; providerId: string; request: ProviderCatalogRequest }>
	| Readonly<{ type: "askSage"; baseUrl: string }>
	| Readonly<{ type: "openRouterKeyInfo"; apiKey: string }>
	| Readonly<{ type: "unsupported"; key: string }>

type Callbacks = Readonly<{
	ollamaValues: (baseUrl: string) => Promise<unknown>
	lmStudioValues: (baseUrl: string) => Promise<unknown>
	refresh: (providerId: string, request: ProviderCatalogRequest) => Promise<unknown>
	askSage: (baseUrl: string) => Promise<unknown>
	openRouterKeyInfo: (apiKey: string) => Promise<unknown>
	unsupported: (key: string) => unknown
}>

export class ModelCatalogRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	handle(command: ModelCatalogCommand): unknown | Promise<unknown> {
		switch (command.type) {
			case "ollamaValues": return this.callbacks.ollamaValues(command.baseUrl)
			case "lmStudioValues": return this.callbacks.lmStudioValues(command.baseUrl)
			case "refresh": return this.callbacks.refresh(command.providerId, command.request)
			case "askSage": return this.callbacks.askSage(command.baseUrl)
			case "openRouterKeyInfo": return this.callbacks.openRouterKeyInfo(command.apiKey)
			case "unsupported": return this.callbacks.unsupported(command.key)
		}
	}
}
