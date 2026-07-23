const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { executeHookScript } = require("../dist/infrastructure/hooks/HookRuntime")

test("hook timeout waits until the child process has actually exited", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-hook-timeout-"))
	const scriptPath = path.join(directory, "hook.js")
	const previousTimeout = process.env.VSCLINE_HOOK_TIMEOUT_MS
	let child
	try {
		fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000)\n", "utf8")
		process.env.VSCLINE_HOOK_TIMEOUT_MS = "50"
		const registry = {
			track(process) { child = process },
			untrack() {},
		}

		const result = await executeHookScript(
			{ name: "TaskStart", source: "workspace", path: scriptPath, enabled: true },
			{ workspaceRoot: directory },
			registry,
		)

		assert.match(result.error, /Hook timed out/)
		assert.ok(child)
		assert.ok(child.exitCode !== null || child.signalCode !== null, "hook process was still running when timeout completed")
	} finally {
		if (previousTimeout === undefined) delete process.env.VSCLINE_HOOK_TIMEOUT_MS
		else process.env.VSCLINE_HOOK_TIMEOUT_MS = previousTimeout
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
