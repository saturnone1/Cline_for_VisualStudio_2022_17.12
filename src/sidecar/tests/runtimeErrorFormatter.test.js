const assert = require("node:assert/strict")
const test = require("node:test")
const { formatSdkErrorForUi } = require("../dist/infrastructure/webview/RuntimeErrorFormatter")

test("SDK object errors remain structured instead of rendering as object Object", () => {
	const text = formatSdkErrorForUi({ error: "validation failed", details: { maximum: 5 } }, "en")
	assert.doesNotMatch(text, /\[object Object\]/)
	assert.match(text, /validation failed/)
	assert.match(text, /maximum/)
})
