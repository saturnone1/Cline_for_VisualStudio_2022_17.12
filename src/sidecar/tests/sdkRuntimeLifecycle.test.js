const assert = require("node:assert/strict")
const test = require("node:test")
const { ClineSdkRuntime } = require("../dist/infrastructure/sdk/ClineSdkRuntime")
const { ClineSdkMcpAdapter } = require("../dist/infrastructure/sdk/ClineSdkMcpAdapter")

function deferred() {
	let resolve
	const promise = new Promise((complete) => { resolve = complete })
	return { promise, resolve }
}

test("SDK runtime disposes a core that finishes starting after shutdown", async () => {
	const startup = deferred()
	let disposeCalls = 0
	const core = {
		listHistory: async () => [],
		dispose: async () => { disposeCalls++ },
	}
	const runtime = new ClineSdkRuntime({}, __dirname, undefined, undefined, undefined, undefined, undefined, undefined, () => startup.promise)
	const starting = runtime.ensureStarted()
	const disposing = runtime.dispose()
	startup.resolve(core)

	await assert.rejects(starting, /disposed during startup/)
	await disposing
	assert.equal(disposeCalls, 1)
	await assert.rejects(runtime.ensureStarted(), /has been disposed/)
})

test("MCP runtime disposes a manager that finishes starting after shutdown", async () => {
	const startup = deferred()
	let disposeCalls = 0
	const manager = { dispose: async () => { disposeCalls++ } }
	const runtime = new ClineSdkMcpAdapter({}, () => null, () => {}, () => startup.promise)
	const starting = runtime.ensureStarted()
	const disposing = runtime.dispose()
	startup.resolve(manager)

	await assert.rejects(starting, /disposed during startup/)
	await disposing
	assert.equal(disposeCalls, 1)
	await assert.rejects(runtime.ensureStarted(), /has been disposed/)
})
