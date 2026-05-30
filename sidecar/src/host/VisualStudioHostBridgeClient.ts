import { JsonRpcConnection, sendHostRequest } from "../ipc/types"

export type WorkspaceRoot = {
	path: string
	name: string
}

export type PlatformInfo = {
	platform: string
	appName: string
	host: string
	version?: string
}

export type FileDiagnostics = {
	filePath: string
	diagnostics: Array<{
		message: string
		line: number
		severity: string
	}>
}

export class VisualStudioHostBridgeClient {
	constructor(private readonly connection: JsonRpcConnection) {}

	async health() {
		return sendHostRequest(this.connection, "host.health", {
			from: "cline-sidecar",
			protocol: 1,
		})
	}

	async getWorkspaceRoots(): Promise<WorkspaceRoot[]> {
		return (await sendHostRequest(this.connection, "workspace.getRoots", null)) as WorkspaceRoot[]
	}

	async getWorkspacePaths(): Promise<string[]> {
		return (await sendHostRequest(this.connection, "workspace.getWorkspacePaths", null)) as string[]
	}

	async getDiagnostics(): Promise<{ fileDiagnostics: FileDiagnostics[] }> {
		return (await sendHostRequest(this.connection, "workspace.getDiagnostics", null)) as {
			fileDiagnostics: FileDiagnostics[]
		}
	}

	async getOpenDocuments(): Promise<string[]> {
		return (await sendHostRequest(this.connection, "workspace.getOpenDocuments", null)) as string[]
	}

	async getActiveFile(): Promise<{ path: string | null }> {
		return (await sendHostRequest(this.connection, "window.getActiveFile", null)) as { path: string | null }
	}

	async fileExists(path: string): Promise<boolean> {
		const result = (await sendHostRequest(this.connection, "workspace.fileExists", { path })) as { exists: boolean }
		return result.exists === true
	}

	async readTextFile(path: string): Promise<{ exists: boolean; content: string }> {
		return (await sendHostRequest(this.connection, "workspace.readTextFile", { path })) as {
			exists: boolean
			content: string
		}
	}

	async writeTextFile(path: string, content: string) {
		return sendHostRequest(this.connection, "workspace.writeTextFile", { path, content })
	}

	async createDirectory(path: string) {
		return sendHostRequest(this.connection, "workspace.createDirectory", { path })
	}

	async listFiles(path: string, recursive = false, limit = 5000): Promise<{ files: string[]; truncated: boolean }> {
		return (await sendHostRequest(this.connection, "workspace.listFiles", { path, recursive, limit })) as {
			files: string[]
			truncated: boolean
		}
	}

	async searchFiles(path: string, query: string, limit = 500): Promise<{ matches: string[]; truncated: boolean }> {
		return (await sendHostRequest(this.connection, "workspace.searchFiles", { path, query, limit })) as {
			matches: string[]
			truncated: boolean
		}
	}

	async showMessage(message: string, type = "info") {
		return sendHostRequest(this.connection, "window.showMessage", { message, type })
	}

	async openFile(filePath: string) {
		return sendHostRequest(this.connection, "window.openFile", { filePath })
	}

	async openFileAtLine(filePath: string, line?: number) {
		return sendHostRequest(this.connection, "window.openFile", { filePath, line })
	}

	async getPlatform(): Promise<PlatformInfo> {
		return (await sendHostRequest(this.connection, "env.getHostVersion", null)) as PlatformInfo
	}

	async clipboardReadText(): Promise<string> {
		const result = (await sendHostRequest(this.connection, "env.clipboardReadText", null)) as { value: string }
		return result.value || ""
	}

	async clipboardWriteText(value: string) {
		return sendHostRequest(this.connection, "env.clipboardWriteText", { value })
	}

	async openExternal(value: string) {
		return sendHostRequest(this.connection, "env.openExternal", { value })
	}

	async debugLog(message: string) {
		return sendHostRequest(this.connection, "env.debugLog", { message })
	}

	async postWebviewMessage(message: unknown) {
		return sendHostRequest(this.connection, "webview.postMessage", { message })
	}

	async executeCommandInTerminal(command: string, cwd?: string, timeoutSeconds?: number) {
		return sendHostRequest(this.connection, "workspace.executeCommandInTerminal", {
			command,
			cwd,
			timeoutSeconds,
		})
	}

	async cancelCommands() {
		return sendHostRequest(this.connection, "workspace.cancelCommands", null)
	}

	async saveOpenDocumentIfDirty(filePath: string) {
		return sendHostRequest(this.connection, "workspace.saveOpenDocumentIfDirty", { filePath })
	}

	async openProblemsPanel() {
		return sendHostRequest(this.connection, "workspace.openProblemsPanel", null)
	}

	async openTerminalPanel() {
		return sendHostRequest(this.connection, "workspace.openTerminalPanel", null)
	}

	async openDiff(leftPath: string, rightPath: string, title?: string) {
		return sendHostRequest(this.connection, "diff.openDiff", { leftPath, rightPath, title })
	}

	async closeAllDiffs() {
		return sendHostRequest(this.connection, "diff.closeAllDiffs", null)
	}
}
