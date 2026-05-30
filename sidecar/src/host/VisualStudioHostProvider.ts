import path from "node:path"
import { VisualStudioHostBridgeClient } from "./VisualStudioHostBridgeClient"
import type { JsonRpcConnection } from "../ipc/types"

export type VisualStudioHostProviderOptions = {
	extensionFsPath: string
	globalStorageFsPath: string
}

export class VisualStudioHostProvider {
	readonly workspaceClient: VisualStudioWorkspaceClient
	readonly envClient: VisualStudioEnvClient
	readonly windowClient: VisualStudioWindowClient
	readonly diffClient: VisualStudioDiffClient
	readonly extensionFsPath: string
	readonly globalStorageFsPath: string

	private constructor(private readonly bridge: VisualStudioHostBridgeClient, options: VisualStudioHostProviderOptions) {
		this.workspaceClient = new VisualStudioWorkspaceClient(bridge)
		this.envClient = new VisualStudioEnvClient(bridge)
		this.windowClient = new VisualStudioWindowClient(bridge)
		this.diffClient = new VisualStudioDiffClient(bridge)
		this.extensionFsPath = options.extensionFsPath
		this.globalStorageFsPath = options.globalStorageFsPath
	}

	static create(connection: JsonRpcConnection, options?: Partial<VisualStudioHostProviderOptions>) {
		const extensionFsPath = options?.extensionFsPath || path.resolve(__dirname, "..")
		const globalStorageFsPath = options?.globalStorageFsPath || path.join(process.env.LOCALAPPDATA || extensionFsPath, "VsClineAgent")
		return new VisualStudioHostProvider(new VisualStudioHostBridgeClient(connection), {
			extensionFsPath,
			globalStorageFsPath,
		})
	}

	async roundtrip() {
		const [health, workspaceRoots, platform] = await Promise.all([
			this.bridge.health(),
			this.workspaceClient.getWorkspacePaths({}),
			this.envClient.getHostVersion({}),
		])

		return {
			health,
			workspaceRoots,
			platform,
			extensionFsPath: this.extensionFsPath,
			globalStorageFsPath: this.globalStorageFsPath,
		}
	}
}

class VisualStudioWorkspaceClient {
	constructor(private readonly bridge: VisualStudioHostBridgeClient) {}

	getWorkspacePaths(_request: unknown) {
		return this.bridge.getWorkspacePaths()
	}

	getDiagnostics(_request: unknown) {
		return this.bridge.getDiagnostics()
	}

	readTextFile(request: { path?: string }) {
		return this.bridge.readTextFile(request.path || "")
	}

	writeTextFile(request: { path?: string; content?: string }) {
		return this.bridge.writeTextFile(request.path || "", request.content || "")
	}

	createDirectory(request: { path?: string }) {
		return this.bridge.createDirectory(request.path || "")
	}

	listFiles(request: { path?: string; recursive?: boolean; limit?: number }) {
		return this.bridge.listFiles(request.path || "", request.recursive === true, request.limit)
	}

	searchFiles(request: { path?: string; query?: string; limit?: number }) {
		return this.bridge.searchFiles(request.path || "", request.query || "", request.limit)
	}

	executeCommandInTerminal(request: { command?: string; cwd?: string; timeoutSeconds?: number }) {
		return this.bridge.executeCommandInTerminal(request.command || "", request.cwd || "", request.timeoutSeconds)
	}

	cancelCommands() {
		return this.bridge.cancelCommands()
	}

	saveOpenDocumentIfDirty(request: { filePath?: string }) {
		return this.bridge.saveOpenDocumentIfDirty(request.filePath || "")
	}

	openProblemsPanel(_request: unknown) {
		return this.bridge.openProblemsPanel()
	}

	openTerminalPanel(_request: unknown) {
		return this.bridge.openTerminalPanel()
	}
}

class VisualStudioWindowClient {
	constructor(private readonly bridge: VisualStudioHostBridgeClient) {}

	getActiveEditor(_request: unknown) {
		return this.bridge.getActiveFile()
	}

	getOpenTabs(_request: unknown) {
		return this.bridge.getOpenDocuments()
	}

	getVisibleTabs(_request: unknown) {
		return this.bridge.getOpenDocuments()
	}

	openFile(request: { filePath?: string; line?: number; preview?: boolean }) {
		return this.bridge.openFileAtLine(request.filePath || "", request.line)
	}

	showTextDocument(request: { filePath?: string; line?: number; preview?: boolean }) {
		return this.bridge.openFileAtLine(request.filePath || "", request.line)
	}

	showMessage(request: { message?: string; type?: string; options?: unknown }) {
		return this.bridge.showMessage(request.message || "", request.type || "info")
	}
}

class VisualStudioEnvClient {
	constructor(private readonly bridge: VisualStudioHostBridgeClient) {}

	getHostVersion(_request: unknown) {
		return this.bridge.getPlatform()
	}

	clipboardReadText(_request: unknown) {
		return this.bridge.clipboardReadText()
	}

	clipboardWriteText(request: { value?: string; text?: string }) {
		return this.bridge.clipboardWriteText(request.value ?? request.text ?? "")
	}

	openExternal(request: { value?: string; uri?: string }) {
		return this.bridge.openExternal(request.value ?? request.uri ?? "")
	}

	debugLog(request: { message?: string }) {
		return this.bridge.debugLog(request.message || "")
	}
}

class VisualStudioDiffClient {
	constructor(private readonly bridge: VisualStudioHostBridgeClient) {}

	openDiff(request: { leftPath?: string; rightPath?: string; title?: string }) {
		return this.bridge.openDiff(request.leftPath || "", request.rightPath || "", request.title || "")
	}

	closeAllDiffs(_request: unknown) {
		return this.bridge.closeAllDiffs()
	}
}
