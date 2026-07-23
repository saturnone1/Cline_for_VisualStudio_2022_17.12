const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { LocalFileInteractionAdapter } = require("../dist/infrastructure/files/LocalFileInteractionAdapter")

test("instruction files are created in SDK-compatible roots and deletion is confined", { concurrency: false }, async () => {
	const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "vscline-file-actions-"))
	const workspace = path.join(sandbox, "workspace")
	const clineDir = path.join(sandbox, "cline-home")
	await fs.mkdir(workspace, { recursive: true })
	const previous = process.env.CLINE_DIR
	process.env.CLINE_DIR = clineDir
	const opened = []
	const adapter = new LocalFileInteractionAdapter(host(opened))
	try {
		const rule = await adapter.createRule({ isGlobal: false, filename: "review.md", type: "cline" }, workspace)
		const skill = await adapter.createSkill({ isGlobal: true, skillName: "review-code" }, workspace)
		assert.equal(rule, path.join(workspace, ".clinerules", "review.md"))
		assert.equal(skill, path.join(clineDir, "skills", "review-code", "SKILL.md"))
		assert.match(await fs.readFile(skill, "utf8"), /name: review-code/)
		assert.deepEqual(opened, [rule, skill])

		await assert.rejects(() => adapter.deleteRule({ isGlobal: false, rulePath: path.join(sandbox, "unrelated.md") }, workspace), /outside/)
		await adapter.deleteRule({ isGlobal: false, rulePath: rule }, workspace)
		await adapter.deleteSkill({ isGlobal: true, skillPath: skill }, workspace)
		await assert.rejects(() => fs.access(rule))
		await assert.rejects(() => fs.access(skill))
	} finally {
		if (previous === undefined) delete process.env.CLINE_DIR
		else process.env.CLINE_DIR = previous
		await fs.rm(sandbox, { recursive: true, force: true })
	}
})

test("data URL images are materialized before opening", async () => {
	const opened = []
	const adapter = new LocalFileInteractionAdapter(host(opened))
	await adapter.openImage("data:image/png;base64,aGVsbG8=")
	assert.equal(opened.length, 1)
	assert.equal(path.extname(opened[0]), ".png")
	assert.equal(await fs.readFile(opened[0], "utf8"), "hello")
	await fs.rm(opened[0], { force: true })
})

function host(opened) {
	return {
		windowClient: {
			openFile: async ({ filePath }) => { opened.push(filePath) },
			showMessage: async () => ({}),
		},
		envClient: { openExternal: async () => ({}) },
	}
}
