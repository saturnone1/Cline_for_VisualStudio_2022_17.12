export type StreamCommand =
	| Readonly<{ type: "state" }>
	| Readonly<{ type: "auth" }>
	| Readonly<{ type: "partial" }>
	| Readonly<{ type: "mcpServers" }>
	| Readonly<{ type: "mcpMarketplace" }>
	| Readonly<{ type: "inert" }>

export type StreamSubscriptionResult =
	| Readonly<{ kind: "direct"; messages: unknown[] }>
	| Readonly<{ kind: "payload"; payload: unknown }>
	| Readonly<{ kind: "empty" }>
	| Readonly<{ kind: "inert"; reason: "registered_inert_stream" }>

type Callbacks = Readonly<{
	scheduleStateRefresh: () => void
	subscribeState: (requestId: string) => unknown
	subscribePartial: (requestId: string) => void
	unauthenticatedAccount: () => unknown
	mcpServers: () => Promise<unknown>
	mcpMarketplace: () => Promise<unknown>
}>

export class StreamingRpcHandler {
	private readonly mcpRequests = new Set<string>()

	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: StreamCommand, requestId: string): Promise<StreamSubscriptionResult> {
		switch (command.type) {
			case "state": this.callbacks.scheduleStateRefresh(); return { kind: "direct", messages: [this.callbacks.subscribeState(requestId)] }
			case "auth": return { kind: "payload", payload: this.callbacks.unauthenticatedAccount() }
			case "partial": this.callbacks.subscribePartial(requestId); return { kind: "empty" }
			case "mcpServers": this.mcpRequests.add(requestId); return { kind: "payload", payload: await this.callbacks.mcpServers() }
			case "mcpMarketplace": return { kind: "payload", payload: await this.callbacks.mcpMarketplace() }
			case "inert": return { kind: "inert", reason: "registered_inert_stream" }
		}
	}

	unsubscribeMcp(requestId: string) { return this.mcpRequests.delete(requestId) }
	clear() { this.mcpRequests.clear() }
	mcpMessages(payload: unknown, encode: (requestId: string, payload: unknown) => unknown) { return [...this.mcpRequests].filter(Boolean).map((requestId) => encode(requestId, payload)) }
}
