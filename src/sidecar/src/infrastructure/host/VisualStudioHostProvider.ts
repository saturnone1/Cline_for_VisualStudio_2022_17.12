import path from "node:path"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import { VisualStudioHostBridgeClient } from "./VisualStudioHostBridgeClient"
import type { JsonRpcConnection } from "../transport/JsonRpcConnection"

export type VisualStudioHostProviderOptions = {
	extensionFsPath: string
	globalStorageFsPath: string
}

export class VisualStudioHostProvider implements HostProviderPort {
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
	private static cachedWorkspacePaths: { value: string[]; expiresAt: number } | null = null
	private static workspacePathsRequest: Promise<string[]> | null = null

	constructor(private readonly bridge: VisualStudioHostBridgeClient) {}

	getWorkspacePaths(_request: unknown) {
		const now = Date.now()
		if (VisualStudioWorkspaceClient.cachedWorkspacePaths && VisualStudioWorkspaceClient.cachedWorkspacePaths.expiresAt > now) {
			return Promise.resolve(VisualStudioWorkspaceClient.cachedWorkspacePaths.value)
		}
		if (VisualStudioWorkspaceClient.workspacePathsRequest) {
			return VisualStudioWorkspaceClient.workspacePathsRequest
		}

		VisualStudioWorkspaceClient.workspacePathsRequest = this.bridge
			.getWorkspacePaths()
			.then((paths) => {
				VisualStudioWorkspaceClient.cachedWorkspacePaths = {
					value: paths,
					expiresAt: Date.now() + readPositiveIntEnv("VSCLINE_WORKSPACE_PATHS_CACHE_MS", 5000),
				}
				return paths
			})
			.finally(() => {
				VisualStudioWorkspaceClient.workspacePathsRequest = null
			})
		return VisualStudioWorkspaceClient.workspacePathsRequest
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

	deleteFile(request: { path?: string }) {
		return this.bridge.deleteFile(request.path || "")
	}

	createDirectory(request: { path?: string }) {
		return this.bridge.createDirectory(request.path || "")
	}

	listFiles(request: { path?: string; recursive?: boolean; limit?: number }) {
		return this.bridge.listFiles(request.path || "", request.recursive === true, clampLimit(request.limit, 1500, 5000))
	}

	searchFiles(request: { path?: string; query?: string; limit?: number }) {
		return this.bridge.searchFiles(request.path || "", request.query || "", clampLimit(request.limit, 200, 1000))
	}

	selectFiles(request: { allowImages?: boolean; value?: boolean }) {
		return this.bridge.selectFiles(request.allowImages === true || request.value === true)
	}

	executeCommandInTerminal(request: { command?: string; cwd?: string; timeoutSeconds?: number }) {
		return this.bridge.executeCommandInTerminal(request.command || "", request.cwd || "", request.timeoutSeconds)
	}

	cancelCommands() {
		return this.bridge.cancelCommands()
	}

	getTerminalState(_request: unknown) {
		return this.bridge.getTerminalState()
	}

	getUnretrievedTerminalOutput(request: { afterSequence?: number }) {
		return this.bridge.getUnretrievedTerminalOutput(request.afterSequence || 0)
	}

	saveOpenDocumentIfDirty(request: { filePath?: string }) {
		return this.bridge.saveOpenDocumentIfDirty(request.filePath || "")
	}

	openProblemsPanel(_request: unknown) {
		return this.bridge.openProblemsPanel()
	}

	openTerminalPanel(request: { terminalId?: string; commandId?: string } = {}) {
		return this.bridge.openTerminalPanel(request)
	}

	attachTerminalCommand(request: { terminalId?: string; commandId?: string }) {
		return this.bridge.attachTerminalCommand(request.commandId || "", request.terminalId)
	}

	continueTerminalCommand(request: { terminalId?: string; commandId?: string }) {
		return this.bridge.continueTerminalCommand(request.commandId || "", request.terminalId)
	}

	openSolution(request: { solutionPath?: string; newWindow?: boolean }) {
		return this.bridge.openSolution(request.solutionPath || "", request.newWindow === true)
	}

	openFolder(request: { folderPath?: string; path?: string; newWindow?: boolean }) {
		return this.bridge.openFolder(request.folderPath || request.path || "", request.newWindow === true)
	}
}

function readPositiveIntEnv(name: string, fallback: number) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function clampLimit(value: number | undefined, fallback: number, max: number) {
	if (!Number.isFinite(value) || !value || value <= 0) {
		return fallback
	}
	return Math.min(Math.floor(value), max)
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
