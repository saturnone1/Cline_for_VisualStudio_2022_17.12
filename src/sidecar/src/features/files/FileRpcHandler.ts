import type { HostProviderPort } from "../../application/ports/HostProviderPort"

export type RevertChangesRequest = Readonly<{ files: ReadonlyArray<Readonly<{ filePath: string; beforePath: string; action: string }>> }>

export type FileCommand =
	| Readonly<{ type: "noop" }>
	| Readonly<{ type: "openDiff"; leftPath: string; rightPath: string; title: string }>
	| Readonly<{ type: "revert"; request: RevertChangesRequest }>
	| Readonly<{ type: "copy"; text: string }>
	| Readonly<{ type: "exists"; relativePath: string }>
	| Readonly<{ type: "relativePaths" }>
	| Readonly<{ type: "searchFiles" }>
	| Readonly<{ type: "searchCommits" }>
	| Readonly<{ type: "select"; allowImages: boolean }>
	| Readonly<{ type: "openFile"; filePath: string; line?: number }>

export type FileRpcResult = Readonly<{ payload: unknown; includeStateMessages?: boolean }>

type Callbacks = Readonly<{
	host: HostProviderPort
	workspaceRoot: () => Promise<string>
	resolvePath: (workspaceRoot: string, filePath: string) => string
	baseName: (filePath: string) => string
	exists: (filePath: string) => boolean
	revert: (request: RevertChangesRequest) => Promise<unknown>
}>

export class FileRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: FileCommand): Promise<FileRpcResult> {
		const host = this.callbacks.host
		switch (command.type) {
			case "noop": return empty()
			case "openDiff": {
				const title = command.title || (command.rightPath ? `LIG VS change: ${this.callbacks.baseName(command.rightPath)}` : "LIG VS change")
				if (command.leftPath && command.rightPath) await host.diffClient.openDiff({ leftPath: command.leftPath, rightPath: command.rightPath, title })
				else if (command.rightPath) await host.windowClient.openFile({ filePath: command.rightPath })
				return empty()
			}
			case "revert": return { payload: await this.callbacks.revert(command.request), includeStateMessages: true }
			case "copy": await host.envClient.clipboardWriteText({ value: command.text }); return empty()
			case "exists": {
				const root = await this.callbacks.workspaceRoot(), fullPath = root && command.relativePath ? this.callbacks.resolvePath(root, command.relativePath) : ""
				return { payload: { value: fullPath ? this.callbacks.exists(fullPath) : false } }
			}
			case "relativePaths": return { payload: { values: [], paths: [] } }
			case "searchFiles": return { payload: { results: [], values: [] } }
			case "searchCommits": return { payload: { commits: [], values: [] } }
			case "select": return this.select(command.allowImages)
			case "openFile": {
				const root = await this.callbacks.workspaceRoot(), fullPath = command.filePath ? this.callbacks.resolvePath(root, command.filePath) : ""
				if (fullPath) await host.windowClient.openFile({ filePath: fullPath, line: command.line })
				return empty()
			}
		}
	}

	private async select(allowImages: boolean): Promise<FileRpcResult> {
		try {
			const selected = asRecord(await this.callbacks.host.workspaceClient.selectFiles({ allowImages }))
			return { payload: { values1: Array.isArray(selected.values1) ? selected.values1 : selected.images || [], values2: Array.isArray(selected.values2) ? selected.values2 : selected.files || [] } }
		} catch (error) {
			const message = stringify(error)
			await this.callbacks.host.windowClient.showMessage({ message: `LIG VS could not open the file picker: ${message}`, type: "warning" })
			return { payload: { values1: [], values2: [], error: message } }
		}
	}
}

function empty(): FileRpcResult { return { payload: {} } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
