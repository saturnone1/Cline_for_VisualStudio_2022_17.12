const assert = require("node:assert/strict")
const test = require("node:test")
const { StatePersistenceUseCase } = require("../dist/application/useCases/StatePersistenceUseCase")

test("state persistence coalesces scheduled writes and flushes the latest snapshot", async () => {
	const writes = []
	const store = { load: () => null, save: (value) => writes.push(value), clear() {} }
	const useCase = new StatePersistenceUseCase(store, 50)
	let version = 1

	useCase.schedule(() => ({ version }))
	version = 2
	useCase.schedule(() => ({ version }))
	useCase.flush(() => ({ version }))
	await new Promise((resolve) => setTimeout(resolve, 70))

	assert.deepEqual(writes, [{ version: 2 }])
})

test("state persistence clears pending writes before clearing storage", async () => {
	const calls = []
	const store = { load: () => null, save: () => calls.push("save"), clear: () => calls.push("clear") }
	const useCase = new StatePersistenceUseCase(store, 20)
	useCase.schedule(() => ({}))
	useCase.clear()
	await new Promise((resolve) => setTimeout(resolve, 35))
	assert.deepEqual(calls, ["clear"])
})

test("state persistence surfaces synchronous disk failures to the caller", () => {
	const failure = new Error("disk is read-only")
	const store = { load: () => null, save: () => { throw failure }, clear() {} }
	const useCase = new StatePersistenceUseCase(store, 20)

	assert.throws(() => useCase.flush(() => ({ version: 1 })), /disk is read-only/)
	assert.equal(useCase.persistenceError, failure)
})

test("deferred persistence keeps only the latest snapshot while a write is active", async () => {
	const writes = []
	let releaseFirst
	const firstWrite = new Promise((resolve) => { releaseFirst = resolve })
	const store = {
		load: () => null,
		save: () => {}, clear: () => {},
		saveDeferred: async (value) => {
			writes.push(value)
			if (writes.length === 1) await firstWrite
		},
	}
	const useCase = new StatePersistenceUseCase(store, 1)
	let version = 1
	useCase.schedule(() => ({ version }))
	await new Promise((resolve) => setTimeout(resolve, 5))
	version = 2
	useCase.schedule(() => ({ version }))
	await new Promise((resolve) => setTimeout(resolve, 5))
	version = 3
	useCase.schedule(() => ({ version }))
	await new Promise((resolve) => setTimeout(resolve, 5))
	releaseFirst()
	await new Promise((resolve) => setTimeout(resolve, 5))

	assert.deepEqual(writes, [{ version: 1 }, { version: 3 }])
})

test("continuous state changes use trailing debounce with a bounded maximum wait", async () => {
	const writes = []
	const store = { load: () => null, save: (value) => writes.push(value), clear() {} }
	const useCase = new StatePersistenceUseCase(store, 30, 70)
	let version = 0
	const interval = setInterval(() => {
		version++
		useCase.schedule(() => ({ version }))
	}, 10)

	await waitFor(() => writes.length > 0, 300)
	clearInterval(interval)
	assert.ok(writes.length >= 1)
	assert.ok(writes[0].version >= 1)

	await waitFor(() => writes.at(-1)?.version === version, 300)
	assert.equal(writes.at(-1).version, version)
})

async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}
