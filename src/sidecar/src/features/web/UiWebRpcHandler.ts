export type UiWebCommand =
	| Readonly<{ type: "empty" }>
	| Readonly<{ type: "announcement" }>
	| Readonly<{ type: "openUrl"; url: string }>
	| Readonly<{ type: "checkImage"; url: string }>
	| Readonly<{ type: "openGraph"; url: string }>

type Callbacks = Readonly<{
	openExternal: (url: string) => Promise<unknown>
	checkImage: (url: string) => Promise<unknown>
	openGraph: (url: string) => Promise<unknown>
}>

export class UiWebRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: UiWebCommand) {
		switch (command.type) {
			case "empty": return {}
			case "announcement": return { value: false }
			case "openUrl": await this.callbacks.openExternal(command.url); return {}
			case "checkImage": return this.callbacks.checkImage(command.url)
			case "openGraph": return this.callbacks.openGraph(command.url)
		}
	}
}
