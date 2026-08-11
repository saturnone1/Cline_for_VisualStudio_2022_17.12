const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

test("scheduled agent specs and run history are replaced atomically", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-automation-"))
	const previousSettingsRoot = process.env.VSCLINE_SETTINGS_DIR
	process.env.VSCLINE_SETTINGS_DIR = path.join(root, "settings")
	t.after(() => {
		if (previousSettingsRoot === undefined) delete process.env.VSCLINE_SETTINGS_DIR
		else process.env.VSCLINE_SETTINGS_DIR = previousSettingsRoot
		fs.rmSync(root, { recursive: true, force: true })
	})

	const store = require("../dist/infrastructure/persistence/LocalAutomationStore")
	const workspace = path.join(root, "workspace")
	const spec = store.writeScheduledAgentSpec(workspace, { id: "daily", name: "Daily", prompt: "Review changes" })
	assert.equal(spec.id, "daily")
	assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, ".cline", "cron", "daily.json"), "utf8")).prompt, "Review changes")

	store.appendScheduledAgentRun({ specId: "daily", status: "completed" })
	const runsPath = path.join(root, "settings", "scheduled-runs.json")
	assert.equal(JSON.parse(fs.readFileSync(runsPath, "utf8")).length, 1)
	assert.deepEqual(fs.readdirSync(path.dirname(runsPath)).filter((name) => name.endsWith(".tmp")), [])
})
