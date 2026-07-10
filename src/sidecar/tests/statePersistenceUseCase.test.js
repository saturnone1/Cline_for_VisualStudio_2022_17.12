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
