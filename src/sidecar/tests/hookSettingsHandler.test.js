const assert = require("node:assert/strict")
const test = require("node:test")
const { HookSettingsHandler } = require("../dist/features/hooks/HookSettingsHandler")

function fixture(initial = []) {
	const scripts = [...initial]
	const calls = []
	const store = {
		list: () => [...scripts],
		create: (source, _root, name) => { calls.push(["create", source, name]); scripts.push({ name, source, path: `${source}/${name}.ps1`, enabled: true }) },
		delete: (source, _root, name) => { calls.push(["delete", source, name]); const index = scripts.findIndex((item) => item.source === source && item.name === name); if (index >= 0) scripts.splice(index, 1) },
		setEnabled: (source, _root, name, enabled) => { calls.push(["toggle", source, name, enabled]); const script = scripts.find((item) => item.source === source && item.name === name); if (script) script.enabled = enabled },
		workspaceName: () => "repo",
	}
	return { handler: new HookSettingsHandler(store), calls, scripts }
}

test("hook settings handler projects global and workspace hooks", () => {
	const { handler } = fixture([
		{ name: "TaskStart", source: "global", path: "global/TaskStart.ps1", enabled: true },
		{ name: "PreToolUse", source: "workspace", path: "local/PreToolUse.ps1", enabled: false },
	])
	const settings = handler.settings("C:/repo")
	assert.equal(settings.globalHooks[0].absolutePath, "global/TaskStart.ps1")
	assert.equal(settings.workspaceHooks[0].workspaceName, "repo")
	assert.equal(settings.workspaceHooks[0].hooks[0].enabled, false)
})

test("hook settings handler normalizes names and delegates create/delete/toggle", () => {
	const { handler, calls } = fixture()
	handler.create({ hookName: "taskstart", isGlobal: true }, "C:/repo")
	handler.toggle({ name: "TaskStart", isGlobal: true, enabled: false }, "C:/repo")
	handler.delete({ hookName: "TaskStart", isGlobal: true }, "C:/repo")
	assert.deepEqual(calls, [["create", "global", "TaskStart"], ["toggle", "global", "TaskStart", false], ["delete", "global", "TaskStart"]])
})

test("hook settings handler rejects unsupported hooks and workspace creation without a workspace", () => {
	const { handler } = fixture()
	assert.throws(() => handler.create({ hookName: "Unknown" }, "C:/repo"), /supported hook name/)
	assert.throws(() => handler.create({ hookName: "TaskStart" }, ""), /No workspace/)
})
