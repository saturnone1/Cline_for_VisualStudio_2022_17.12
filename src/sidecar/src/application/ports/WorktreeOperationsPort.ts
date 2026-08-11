export type GitCommandResult = Readonly<{ success: boolean; stdout: string; stderr: string; exitCode: number }>

export interface WorktreeOperationsPort {
	readonly currentDirectory: string
	getWorkspacePaths(): Promise<string[]>
	runGit(args: readonly string[], cwd: string): Promise<GitCommandResult>
	pathExists(value: string): Promise<boolean>
	readTextFile(value: string): Promise<string>
	writeTextFile(value: string, content: string): Promise<void>
	joinPath(...parts: string[]): string
	baseName(value: string): string
	dirName(value: string): string
	samePath(left: string, right: string): boolean
	resolvePath(...parts: string[]): string
	isAbsolutePath(value: string): boolean
	isPathInside(candidate: string, root: string): boolean
	copyPath(source: string, destination: string): Promise<void>
	findSolutions(root: string): string[]
	openFolder(folderPath: string, newWindow: boolean): Promise<unknown>
	openSolution(solutionPath: string, newWindow: boolean): Promise<unknown>
}
