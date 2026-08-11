const assert = require("node:assert/strict")
const test = require("node:test")
const { formatLogMetadata } = require("../dist/infrastructure/diagnostics/SafeLogMetadata")

test("SDK log metadata contains circular values without throwing", () => {
	const metadata = { event: "tool" }
	metadata.self = metadata

	assert.equal(formatLogMetadata(metadata), '{"event":"tool","self":"[Circular]"}')
})

test("SDK log metadata is bounded", () => {
	const formatted = formatLogMetadata({ value: "x".repeat(20_000) })
	assert.ok(formatted.length < 9_000)
	assert.match(formatted, /\[truncated \d+ chars\]$/)
})
