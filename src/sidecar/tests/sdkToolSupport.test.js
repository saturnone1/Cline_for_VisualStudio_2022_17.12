const assert = require("node:assert/strict")
const test = require("node:test")
const { htmlToReadableText, normalizeCommandResultForSdk, normalizeHttpUrl, readPositiveIntEnv } = require("../dist/infrastructure/sdk/SdkToolSupport")
const { boundToolOutput } = require("../dist/infrastructure/sdk/ClineSdkToolExecutorFactory")
const { mapToolName, shouldAutoApproveTool } = require("../dist/infrastructure/conversation/ToolCommandFormatting")

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
	const boundedLines = JSON.parse(normalizeCommandResultForSdk({ stdout: "1\n2\n3\n4\n5\n6" }, 4))
	assert.equal(boundedLines.stdout, "1\n2\n[2 output lines omitted]\n5\n6")
})

test("SDK web support validates URLs and strips non-readable HTML", () => {
	assert.equal(normalizeHttpUrl("example.com/path"), "https://example.com/path")
	assert.equal(normalizeHttpUrl("file:///secret"), "")
	const text = htmlToReadableText("<style>.x{}</style><h1>Title</h1><script>secret()</script><p>A &amp; B</p>")
	assert.equal(text.includes("secret"), false)
	assert.match(text, /Title/)
	assert.match(text, /A & B/)
})

test("web fetch shares the browser approval category", () => {
	assert.equal(mapToolName("fetch_web_content"), "browser_action")
	assert.equal(shouldAutoApproveTool("fetch_web_content", { enabled: true, actions: { useBrowser: true } }), true)
	assert.equal(shouldAutoApproveTool("fetch_web_content", { enabled: true, actions: { useBrowser: false } }), false)
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

test("large SDK tool output preserves bounded head and tail with retrieval guidance", () => {
	const value = "head-" + "x".repeat(10_000) + "-tail"
	const bounded = boundToolOutput(value, 2_000, "File output", "Read a range.")
	assert.equal(bounded.length < 2_200, true)
	assert.equal(bounded.startsWith("head-"), true)
	assert.equal(bounded.endsWith("-tail"), true)
	assert.match(bounded, /truncated: .*Read a range/)
})
