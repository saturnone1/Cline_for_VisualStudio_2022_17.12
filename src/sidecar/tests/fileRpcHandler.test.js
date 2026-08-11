const assert = require("node:assert/strict")
const test = require("node:test")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { FileRpcHandler } = require("../dist/features/files/FileRpcHandler")

function createHandler(overrides = {}) {
	const roots = ["C:\\workspace\\alpha", "C:\\workspace\\beta"]
	const entries = {
		[roots[0]]: ["C:\\workspace\\alpha\\src", "C:\\workspace\\alpha\\src\\main.ts", "C:\\workspace\\alpha\\README"],
		[roots[1]]: ["C:\\workspace\\beta\\docs", "C:\\workspace\\beta\\docs\\guide.md"],
	}
	const directories = new Set([entries[roots[0]][0], entries[roots[1]][0]])
	const callbacks = {
		host: { workspaceClient: {
			getWorkspacePaths: async () => roots,
			listFiles: async ({ path: root }) => ({ files: entries[root] || [], directories: (entries[root] || []).filter((item) => directories.has(item)) }),
		} },
		workspaceRoot: async () => roots[0],
		resolvePath: path.resolve,
		baseName: path.basename,
		exists: () => true,
		revert: async () => ({}),
		toFilePath: (uri) => new URL(uri).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1").replace(/\//g, "\\"),
		relativePath: path.relative,
		isPathInside: (root, target) => target.toLowerCase().startsWith(`${root.toLowerCase()}\\`),
		searchCommits: async () => ({
			success: true,
			stdout: "abcdef1234567890\u001fabcdef1\u001fFix chat state\u001fDev One\u001f2026-07-22\n1234567890abcdef\u001f1234567\u001fAdd docs\u001fDev Two\u001f2026-07-21\n",
		}),
		...overrides,
	}
	return new FileRpcHandler(callbacks)
}

test("relative path conversion uses the best matching workspace root", async () => {
	const handler = createHandler()
	const result = await handler.handle({ type: "relativePaths", uris: [pathToFileURL("C:\\workspace\\alpha\\src\\main.ts").href] })
	assert.deepEqual(result.payload, { values: ["src/main.ts"], paths: ["src/main.ts"] })
})

test("file search preserves file and folder types and workspace hints", async () => {
	const handler = createHandler()
	const files = await handler.handle({ type: "searchFiles", query: "main", selectedType: "FILE", workspaceHint: "alpha" })
	assert.deepEqual(files.payload.results, [{ path: "src/main.ts", type: "file", label: "main.ts", workspaceName: "alpha" }])

	const folders = await handler.handle({ type: "searchFiles", query: "doc", selectedType: "FOLDER", workspaceHint: "beta" })
	assert.deepEqual(folders.payload.results, [{ path: "docs", type: "folder", label: "docs", workspaceName: "beta" }])
})

test("commit search returns structured commits and filters without changing git execution", async () => {
	const handler = createHandler()
	const result = await handler.handle({ type: "searchCommits", query: "docs" })
	assert.deepEqual(result.payload.commits, [{
		hash: "1234567890abcdef",
		shortHash: "1234567",
		subject: "Add docs",
		author: "Dev Two",
		date: "2026-07-21",
	}])
})
