export type HostResponse = Record<string, unknown>

export interface WorkspacePort {
	getWorkspacePaths(request: unknown): Promise<string[]>
	searchFiles(request: HostResponse): Promise<unknown>
	executeCommandInTerminal(request: HostResponse): Promise<unknown>
	cancelCommands(): Promise<unknown>
	readTextFile(request: HostResponse): Promise<unknown>
	writeTextFile(request: HostResponse): Promise<unknown>
	deleteFile(request: HostResponse): Promise<unknown>
	selectFiles(request: HostResponse): Promise<unknown>
	openTerminalPanel(request: HostResponse): Promise<unknown>
	attachTerminalCommand(request: HostResponse): Promise<unknown>
	continueTerminalCommand(request: HostResponse): Promise<unknown>
	getTerminalState(request: HostResponse): Promise<unknown>
	getUnretrievedTerminalOutput(request: HostResponse): Promise<unknown>
	openFolder(request: HostResponse): Promise<unknown>
	openSolution(request: HostResponse): Promise<unknown>
}

export interface EnvironmentPort {
	clipboardWriteText(request: HostResponse): Promise<unknown>
	openExternal(request: HostResponse): Promise<unknown>
	debugLog(request: HostResponse): Promise<unknown>
}

export interface WindowPort {
	openFile(request: HostResponse): Promise<unknown>
	showMessage(request: HostResponse): Promise<unknown>
}

export interface DiffPort {
	openDiff(request: HostResponse): Promise<unknown>
}

export interface HostProviderPort {
	readonly workspaceClient: WorkspacePort
	readonly envClient: EnvironmentPort
	readonly windowClient: WindowPort
	readonly diffClient: DiffPort
	readonly extensionFsPath: string
	readonly globalStorageFsPath: string
}
