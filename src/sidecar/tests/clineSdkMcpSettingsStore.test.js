const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { ClineSdkMcpSettingsStore } = require("../dist/infrastructure/sdk/ClineSdkMcpSettingsStore")

function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-mcp-settings-"))
	const filePath = path.join(root, "settings", "cline_mcp_settings.json")
	const sdk = {
		resolveDefaultMcpSettingsPath: () => filePath,
		loadMcpSettingsFile: ({ filePath: requestedPath }) => JSON.parse(fs.readFileSync(requestedPath, "utf8")),
	}
	return { root, filePath, sdk }
}

test("MCP settings store initializes an empty or missing settings file", (t) => {
	const fixture = createFixture()
	t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))

	const store = new ClineSdkMcpSettingsStore()
	assert.equal(store.resolvePath(fixture.sdk), fixture.filePath)
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.filePath, "utf8")), { mcpServers: {} })

	fs.writeFileSync(fixture.filePath, "", "utf8")
	store.ensureFile(fixture.filePath)
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.filePath, "utf8")), { mcpServers: {} })
})

test("MCP settings store restores a valid backup over a truncated file", (t) => {
	const fixture = createFixture()
	t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
	fs.mkdirSync(path.dirname(fixture.filePath), { recursive: true })
	fs.writeFileSync(fixture.filePath, '{"mcpServers":', "utf8")
	fs.writeFileSync(`${fixture.filePath}.bak`, JSON.stringify({ mcpServers: { stable: { disabled: false } } }), "utf8")

	new ClineSdkMcpSettingsStore().ensureFile(fixture.filePath)
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.filePath, "utf8")), { mcpServers: { stable: { disabled: false } } })
})

test("MCP settings mutations are serialized without dropping concurrent changes", async (t) => {
	const fixture = createFixture()
	t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
	const store = new ClineSdkMcpSettingsStore()
	store.resolvePath(fixture.sdk)

	await Promise.all([
		store.mutate(fixture.sdk, async (settings) => {
			await new Promise((resolve) => setTimeout(resolve, 20))
			settings.mcpServers.first = { disabled: false }
		}),
		store.mutate(fixture.sdk, (settings) => {
			settings.mcpServers.second = { disabled: true }
		}),
	])

	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.filePath, "utf8")), {
		mcpServers: {
			first: { disabled: false },
			second: { disabled: true },
		},
	})
})
