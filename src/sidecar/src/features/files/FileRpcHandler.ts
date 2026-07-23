import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { FileInteractionPort, RuleFileMutation, SkillFileMutation } from "../../application/ports/FileInteractionPort"

export type RevertChangesRequest = Readonly<{ files: ReadonlyArray<Readonly<{ filePath: string; beforePath: string; action: string }>> }>

export type FileCommand =
	| Readonly<{ type: "createRule"; request: RuleFileMutation }>
	| Readonly<{ type: "deleteRule"; request: RuleFileMutation }>
	| Readonly<{ type: "createSkill"; request: SkillFileMutation }>
	| Readonly<{ type: "deleteSkill"; request: SkillFileMutation }>
	| Readonly<{ type: "openMention"; value: string }>
	| Readonly<{ type: "openHistory"; taskId: string }>
	| Readonly<{ type: "openFocus"; taskId: string }>
	| Readonly<{ type: "openImage"; value: string }>
	| Readonly<{ type: "openDiff"; leftPath: string; rightPath: string; title: string }>
	| Readonly<{ type: "revert"; request: RevertChangesRequest }>
	| Readonly<{ type: "copy"; text: string }>
	| Readonly<{ type: "exists"; relativePath: string }>
	| Readonly<{ type: "relativePaths"; uris: readonly string[] }>
	| Readonly<{ type: "searchFiles"; query: string; selectedType?: "FILE" | "FOLDER"; workspaceHint: string }>
	| Readonly<{ type: "searchCommits"; query: string }>
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
	toFilePath: (uri: string) => string
	relativePath: (root: string, target: string) => string
	isPathInside: (root: string, target: string) => boolean
	searchCommits: (workspaceRoot: string) => Promise<Readonly<{ success: boolean; stdout: string }>>
	interactions: FileInteractionPort
	conversationHistory: (taskId: string) => unknown
	focusChain: (taskId: string) => string
	refreshInstructions?: (kind: "instructions" | "skills") => Promise<void>
}>

type FileSearchResult = Readonly<{ path: string; type: "file" | "folder"; label: string; workspaceName: string }>
type CommitSearchResult = Readonly<{ hash: string; shortHash: string; subject: string; author: string; date: string }>

const FILE_SEARCH_LIMIT = 200
const COMMIT_FIELD_SEPARATOR = "\u001f"

export class FileRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: FileCommand): Promise<FileRpcResult> {
		const host = this.callbacks.host
		switch (command.type) {
			case "createRule": await this.callbacks.interactions.createRule(command.request, await this.callbacks.workspaceRoot()); await this.callbacks.refreshInstructions?.("instructions"); return stateChanged()
			case "deleteRule": await this.callbacks.interactions.deleteRule(command.request, await this.callbacks.workspaceRoot()); await this.callbacks.refreshInstructions?.("instructions"); return stateChanged()
			case "createSkill": await this.callbacks.interactions.createSkill(command.request, await this.callbacks.workspaceRoot()); await this.callbacks.refreshInstructions?.("skills"); return stateChanged()
			case "deleteSkill": await this.callbacks.interactions.deleteSkill(command.request, await this.callbacks.workspaceRoot()); await this.callbacks.refreshInstructions?.("skills"); return stateChanged()
			case "openMention": await this.callbacks.interactions.openMention(command.value, await host.workspaceClient.getWorkspacePaths({})); return empty()
			case "openHistory": await this.callbacks.interactions.openConversationHistory(command.taskId, JSON.stringify(this.callbacks.conversationHistory(command.taskId), null, 2)); return empty()
			case "openFocus": await this.callbacks.interactions.openFocusChain(command.taskId, this.callbacks.focusChain(command.taskId)); return empty()
			case "openImage": await this.callbacks.interactions.openImage(command.value); return empty()
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
			case "relativePaths": return this.relativePaths(command.uris)
			case "searchFiles": return this.searchFiles(command)
			case "searchCommits": return this.searchCommits(command.query)
			case "select": return this.select(command.allowImages)
			case "openFile": {
				const root = await this.callbacks.workspaceRoot(), fullPath = command.filePath ? this.callbacks.resolvePath(root, command.filePath) : ""
				if (fullPath) await host.windowClient.openFile({ filePath: fullPath, line: command.line })
				return empty()
			}
		}
	}

	private async relativePaths(uris: readonly string[]): Promise<FileRpcResult> {
		const roots = await this.callbacks.host.workspaceClient.getWorkspacePaths({})
		const paths = uris.map((uri) => this.safeFilePath(uri)).filter(Boolean).map((filePath) => {
			const root = bestContainingRoot(roots, filePath, this.callbacks.isPathInside)
			return normalizeMentionPath(root ? this.callbacks.relativePath(root, filePath) : filePath)
		})
		return { payload: { values: paths, paths } }
	}

	private async searchFiles(command: Extract<FileCommand, { type: "searchFiles" }>): Promise<FileRpcResult> {
		const roots = await this.callbacks.host.workspaceClient.getWorkspacePaths({})
		const selectedRoots = command.workspaceHint
			? roots.filter((root) => this.callbacks.baseName(root).localeCompare(command.workspaceHint, undefined, { sensitivity: "accent" }) === 0)
			: roots
		const query = normalizeMentionPath(command.query).toLocaleLowerCase()
		const results: FileSearchResult[] = []
		for (const root of selectedRoots) {
			const response = asRecord(await this.callbacks.host.workspaceClient.listFiles({ path: root, recursive: true, limit: 5000 }))
			const directories = new Set(stringArray(response.directories).map(normalizeComparablePath))
			for (const entry of stringArray(response.files)) {
				const relative = normalizeMentionPath(this.callbacks.relativePath(root, entry))
				const isFolder = directories.has(normalizeComparablePath(entry))
				const type = isFolder ? "folder" : "file"
				if ((command.selectedType === "FILE" && type !== "file") || (command.selectedType === "FOLDER" && type !== "folder")) continue
				if (query && !relative.toLocaleLowerCase().includes(query)) continue
				results.push({ path: relative, type, label: this.callbacks.baseName(entry), workspaceName: this.callbacks.baseName(root) })
				if (results.length >= FILE_SEARCH_LIMIT) break
			}
			if (results.length >= FILE_SEARCH_LIMIT) break
		}
		return { payload: { results, values: results.map((item) => item.path) } }
	}

	private async searchCommits(query: string): Promise<FileRpcResult> {
		const root = await this.callbacks.workspaceRoot()
		if (!root) return { payload: { commits: [], values: [] } }
		const result = await this.callbacks.searchCommits(root)
		if (!result.success) return { payload: { commits: [], values: [] } }
		const normalizedQuery = query.trim().toLocaleLowerCase()
		const commits = result.stdout.split(/\r?\n/).map(parseCommit).filter((item): item is CommitSearchResult => Boolean(item)).filter((item) => {
			if (!normalizedQuery) return true
			return [item.hash, item.shortHash, item.subject, item.author, item.date].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
		})
		return { payload: { commits, values: commits.map((item) => item.hash) } }
	}

	private safeFilePath(uri: string) {
		try { return this.callbacks.toFilePath(uri) } catch { return "" }
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
function stateChanged(): FileRpcResult { return { payload: {}, includeStateMessages: true } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [] }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
function normalizeMentionPath(value: string) { return value.replace(/\\/g, "/").replace(/^\.\//, "") }
function normalizeComparablePath(value: string) { return normalizeMentionPath(value).toLocaleLowerCase() }
function bestContainingRoot(roots: readonly string[], filePath: string, contains: (root: string, target: string) => boolean) {
	return roots.filter((root) => contains(root, filePath)).sort((left, right) => right.length - left.length)[0] || ""
}
function parseCommit(line: string): CommitSearchResult | null {
	const [hash, shortHash, subject, author, date] = line.split(COMMIT_FIELD_SEPARATOR)
	return hash && shortHash ? { hash, shortHash, subject: subject || "", author: author || "", date: date || "" } : null
}
