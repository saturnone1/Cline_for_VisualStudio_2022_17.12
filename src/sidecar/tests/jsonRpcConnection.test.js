const assert = require("node:assert/strict")
const test = require("node:test")
const { sendHostRequest } = require("../dist/infrastructure/transport/JsonRpcConnection")

test("host request timeout rejects and removes the pending request", async () => {
	const socket = {
		destroyed: false,
		writable: true,
		writableEnded: false,
		write: (_line, callback) => { callback?.(); return true },
	}
	const connection = { socket, nextId: 1, pending: new Map() }

	await assert.rejects(
		sendHostRequest(connection, "workspace.readTextFile", { path: "missing" }, { timeoutMs: 10 }),
		/Host request timed out/,
	)
	assert.equal(connection.pending.size, 0)
})
