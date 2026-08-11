const assert = require("node:assert/strict")
const test = require("node:test")
const { isExpectedRuntimeCancellation } = require("../dist/infrastructure/transport/SidecarRpcServer")
const { tryWriteJsonLine } = require("../dist/infrastructure/transport/JsonRpcSocketWriter")
const { BoundedAsyncRequestQueue, JsonLineFrameDecoder } = require("../dist/infrastructure/transport/JsonRpcIngressLimits")

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

test("JSON-RPC frame decoder rejects complete and unterminated oversized messages", () => {
	const complete = new JsonLineFrameDecoder(8).push('123456789\n')
	assert.equal(complete.overflow, true)

	const partialDecoder = new JsonLineFrameDecoder(8)
	assert.equal(partialDecoder.push("1234").overflow, false)
	assert.equal(partialDecoder.push("56789").overflow, true)
})

test("JSON-RPC frame decoder preserves multiple bounded messages", () => {
	const decoder = new JsonLineFrameDecoder(32)
	assert.deepEqual(decoder.push('{"id":1}\n{"id":').lines, ['{"id":1}'])
	assert.deepEqual(decoder.push('2}\n').lines, ['{"id":2}'])
})

test("bounded request queue caps pending work without losing accepted work", async () => {
	const queue = new BoundedAsyncRequestQueue(1, 1)
	let release
	const gate = new Promise((resolve) => { release = resolve })
	const completed = []
	assert.equal(queue.schedule(async () => { await gate; completed.push(1) }), true)
	assert.equal(queue.schedule(async () => { completed.push(2) }), true)
	assert.equal(queue.schedule(async () => { completed.push(3) }), false)
	release()
	await new Promise((resolve) => setTimeout(resolve, 10))
	assert.deepEqual(completed, [1, 2])
})
