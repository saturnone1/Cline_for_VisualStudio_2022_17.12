const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { applyPatch, resolveKnownToolName } = require("../scripts/patchClineToolCallRepair")

test("tool name recovery accepts only a uniquely registered prefix separated by metadata", () => {
	const tools = [
		"mcp-vs__build_solution",
		"mcp-vs__debugger_launch",
		"mcp-vs__project_list",
		"mcp-vs__find_references",
		"filesystem__list_directory",
		"filesystem__list",
	]
	assert.equal(resolveKnownToolName("mcp-vs__build_solution.json", tools), "mcp-vs__build_solution")
	assert.equal(
		resolveKnownToolName("mcp-vs__debugger_launch<|channel|>commentary", tools),
		"mcp-vs__debugger_launch",
	)
	assert.equal(
		resolveKnownToolName("mcp-vs__project_list<|channel|>commentary", tools),
		"mcp-vs__project_list",
	)
	assert.equal(
		resolveKnownToolName("mcp-vs__find_references<|channel|>commentary", tools),
		"mcp-vs__find_references",
	)
	assert.equal(resolveKnownToolName("filesystem__list_directory<|channel|>commentary", tools), "filesystem__list_directory")
	assert.equal(resolveKnownToolName("filesystem__list_directory_extra", tools), undefined)
	assert.equal(resolveKnownToolName("unknown.json", tools), undefined)
})

test("installed Cline provider repair hook contains the compatibility boundary", () => {
	applyPatch()
	for (const name of ["index.js", "providers.js"]) {
		const source = fs.readFileSync(path.join(__dirname, "..", "node_modules", "@cline", "llms", "dist", name), "utf8")
		assert.match(source, /lig-vs-tool-name-repair/)
	}
	const coreSource = fs.readFileSync(path.join(__dirname, "..", "node_modules", "@cline", "core", "dist", "index.js"), "utf8")
	assert.match(coreSource, /lig-vs-compaction-source/)
	assert.match(coreSource, /\.saveState\?\.\([A-Za-z0-9_$]+,[A-Za-z0-9_$]+\.messages\)/)
	assert.match(coreSource, /persistActiveSessionCompactionState\([A-Za-z0-9_$]+,[A-Za-z0-9_$]+,__ligSourceMessages\)/)
})

test("SDK compaction persistence validates the same source messages that produced the state", async () => {
	applyPatch()
	const { createCompactionStateAwarePrepareTurn } = await import("@cline/core")
	const sourceMessages = [{ role: "user", content: "hello" }]
	let validationSource
	const prepareTurn = createCompactionStateAwarePrepareTurn({
		compact: async () => ({ messages: [{ role: "user", content: "summary" }] }),
		saveState: async (_state, messages) => { validationSource = messages },
	})

	await prepareTurn({
		messages: sourceMessages,
		apiMessages: sourceMessages,
		conversationId: "session-1",
	})

	assert.strictEqual(validationSource, sourceMessages)
})
