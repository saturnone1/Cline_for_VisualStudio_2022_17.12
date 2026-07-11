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
}
