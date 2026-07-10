export interface WorkspacePort {
	getWorkspacePaths(request: unknown): Promise<string[]>
	searchFiles(request: any): Promise<any>
	executeCommandInTerminal(request: any): Promise<any>
	cancelCommands(): Promise<any>
	readTextFile(request: any): Promise<any>
	writeTextFile(request: any): Promise<any>
	deleteFile(request: any): Promise<any>
	selectFiles(request: any): Promise<any>
	openTerminalPanel(request: any): Promise<any>
	attachTerminalCommand(request: any): Promise<any>
	continueTerminalCommand(request: any): Promise<any>
	getTerminalState(request: unknown): Promise<any>
	getUnretrievedTerminalOutput(request: any): Promise<any>
	openFolder(request: any): Promise<any>
	openSolution(request: any): Promise<any>
}

export interface EnvironmentPort {
	clipboardWriteText(request: any): Promise<any>
	openExternal(request: any): Promise<any>
	debugLog(request: any): Promise<any>
}

export interface WindowPort {
	openFile(request: any): Promise<any>
	showMessage(request: any): Promise<any>
}

export interface DiffPort {
	openDiff(request: any): Promise<any>
}

export interface HostProviderPort {
	readonly workspaceClient: WorkspacePort
	readonly envClient: EnvironmentPort
	readonly windowClient: WindowPort
	readonly diffClient: DiffPort
	readonly extensionFsPath: string
	readonly globalStorageFsPath: string
}
