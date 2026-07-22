const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskActivityMonitor } = require("../dist/features/runtime/TaskActivityMonitor")
const { isImportantDiagnosticEvent } = require("../dist/infrastructure/diagnostics/InteractionLog")

test("task activity monitor projects a visible waiting state after first-response silence", async () => {
	const waiting = []
	const monitor = new TaskActivityMonitor(
		{ log: () => undefined },
		() => true,
		() => false,
		(idleForMs, reason) => waiting.push({ idleForMs, reason }),
		() => undefined,
		20,
		1000,
	)
	monitor.note("sdk-send")
	await new Promise((resolve) => setTimeout(resolve, 40))
	monitor.dispose()
	assert.equal(waiting.length, 1)
	assert.equal(waiting[0].reason, "sdk-send")
})

test("latency and idle diagnostics remain enabled without verbose logging", () => {
	assert.equal(isImportantDiagnosticEvent("sendLatency.firstAssistant"), true)
	assert.equal(isImportantDiagnosticEvent("taskIdleNotice"), true)
	assert.equal(isImportantDiagnosticEvent("ordinaryEvent"), false)
})
