const assert = require("node:assert/strict")
const test = require("node:test")
const { htmlToReadableText, normalizeCommandResultForSdk, normalizeHttpUrl, readPositiveIntEnv } = require("../dist/infrastructure/sdk/SdkToolSupport")

test("SDK command results preserve terminal metadata and bound output", () => {
	const previous = process.env.VSCLINE_SDK_COMMAND_RESULT_CHARS
	process.env.VSCLINE_SDK_COMMAND_RESULT_CHARS = "10"
	try {
		assert.match(normalizeCommandResultForSdk("123456789012345"), /truncated 5 chars/)
		const background = JSON.parse(normalizeCommandResultForSdk({ background: true, terminalId: "term-1" }))
		assert.match(background.stdout, /term-1/)
	} finally {
		if (previous === undefined) delete process.env.VSCLINE_SDK_COMMAND_RESULT_CHARS
		else process.env.VSCLINE_SDK_COMMAND_RESULT_CHARS = previous
	}
})

test("SDK web support validates URLs and strips non-readable HTML", () => {
	assert.equal(normalizeHttpUrl("example.com/path"), "https://example.com/path")
	assert.equal(normalizeHttpUrl("file:///secret"), "")
	const text = htmlToReadableText("<style>.x{}</style><h1>Title</h1><script>secret()</script><p>A &amp; B</p>")
	assert.equal(text.includes("secret"), false)
	assert.match(text, /Title/)
	assert.match(text, /A & B/)
})

test("positive integer environment parsing rejects zero and malformed values", () => {
	const previous = process.env.LIGVS_TEST_POSITIVE_INT
	try {
		process.env.LIGVS_TEST_POSITIVE_INT = "42"
		assert.equal(readPositiveIntEnv("LIGVS_TEST_POSITIVE_INT", 7), 42)
		process.env.LIGVS_TEST_POSITIVE_INT = "0"
		assert.equal(readPositiveIntEnv("LIGVS_TEST_POSITIVE_INT", 7), 7)
	} finally {
		if (previous === undefined) delete process.env.LIGVS_TEST_POSITIVE_INT
		else process.env.LIGVS_TEST_POSITIVE_INT = previous
	}
})
