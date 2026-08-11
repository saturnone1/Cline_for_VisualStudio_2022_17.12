import childProcess from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { promisify } from "node:util"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { WorktreeOperationsPort } from "../../application/ports/WorktreeOperationsPort"
import { findSolutions, isPathInside, samePath } from "./WorktreeSupport"

const execFile = promisify(childProcess.execFile)

export class NodeWorktreeOperationsAdapter implements WorktreeOperationsPort {
	constructor(private readonly host: HostProviderPort) {}
	get currentDirectory() { return process.cwd() }
	getWorkspacePaths() { return this.host.workspaceClient.getWorkspacePaths({}) }
	pathExists(value: string) { return fs.promises.access(value).then(() => true).catch(() => false) }
	readTextFile(value: string) { return fs.promises.readFile(value, "utf8") }
	writeTextFile(value: string, content: string) { return fs.promises.writeFile(value, content, "utf8") }
	joinPath(...parts: string[]) { return path.join(...parts) }
	baseName(value: string) { return path.basename(value) }
	dirName(value: string) { return path.dirname(value) }
	samePath(left: string, right: string) { return samePath(left, right) }
	resolvePath(...parts: string[]) { return path.resolve(...parts) }
	isAbsolutePath(value: string) { return path.isAbsolute(value) }
	isPathInside(candidate: string, root: string) { return isPathInside(candidate, root) }
	copyPath(source: string, destination: string) { return fs.promises.cp(source, destination, { recursive: true, force: false, errorOnExist: false }) }
	findSolutions(root: string) { return findSolutions(root) }
	openFolder(folderPath: string, newWindow: boolean) { return this.host.workspaceClient.openFolder({ folderPath, newWindow }) }
	openSolution(solutionPath: string, newWindow: boolean) { return this.host.workspaceClient.openSolution({ solutionPath, newWindow }) }

	async runGit(args: readonly string[], cwd: string) {
		try {
			const result = await execFile("git", [...args], { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 * 8 })
			return { success: true, stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 }
		} catch (error) {
			const record = asRecord(error)
			return { success: false, stdout: readString(record.stdout), stderr: readString(record.stderr) || readString(record.message), exitCode: readNumber(record.code) ?? 1 }
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function readNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null }
