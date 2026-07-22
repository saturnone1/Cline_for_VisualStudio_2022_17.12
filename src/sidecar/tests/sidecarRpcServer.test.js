const assert = require("node:assert/strict")
const test = require("node:test")
const { isExpectedRuntimeCancellation } = require("../dist/infrastructure/transport/SidecarRpcServer")
const { tryWriteJsonLine } = require("../dist/infrastructure/transport/JsonRpcSocketWriter")

test("explicit SDK runtime aborts are treated as normal cancellation", () => {
	const error = new Error("Run aborted")
	error.name = "AgentRuntimeAbortError"
	assert.equal(isExpectedRuntimeCancellation(error), true)
	assert.equal(isExpectedRuntimeCancellation(new Error("model request failed")), false)
})

test("JSON-RPC writer refuses a socket that has already ended", () => {
	let writes = 0
	const socket = {
		destroyed: false,
		writable: true,
		writableEnded: true,
		write: () => { writes++; return false },
	}
	assert.equal(tryWriteJsonLine(socket, { id: "1" }), false)
	assert.equal(writes, 0)
})

test("JSON-RPC writer contains asynchronous stream write errors", () => {
	const errors = []
	const socket = {
		destroyed: false,
		writable: true,
		writableEnded: false,
		write: (_line, callback) => { callback(new Error("write after end")); return false },
	}
	assert.equal(tryWriteJsonLine(socket, { id: "2" }, (error) => errors.push(error.message)), true)
	assert.deepEqual(errors, ["write after end"])
})
