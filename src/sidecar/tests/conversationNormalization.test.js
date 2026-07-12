const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const {
	buildTaskInputWithAttachments,
	formatAttachmentSummaryValue,
	getImageMimeType,
	normalizeSdkImageInput,
} = require("../dist/infrastructure/conversation/AttachmentNormalization")
const { normalizeUsageSnapshot } = require("../dist/infrastructure/conversation/UsageNormalization")
const { createHistoryItem, removeDeletedHistoryItems, sdkSessionToHistoryItem } = require("../dist/infrastructure/conversation/TaskHistoryProjection")
const { completionCandidateToText, extractCompletionTextFromResult } = require("../dist/infrastructure/conversation/CompletionExtraction")
const { isToolTranscript, looksLikeReasoningNarration, looksLikeTokenizedReasoning, mergeTextDelta, normalizeTranscriptText } = require("../dist/infrastructure/conversation/TranscriptTextPolicy")

test("attachment normalization keeps transcript summaries bounded", () => {
	assert.equal(formatAttachmentSummaryValue("data:image/png;base64,AAAA"), "[attached image/png]")
	assert.equal(buildTaskInputWithAttachments("inspect", ["data:image/png;base64,AAAA"], ["readme.md"]),
		"inspect\n\nAttachments:\nImage: [attached image/png]\nFile: readme.md")
	assert.equal(getImageMimeType("image.JPEG"), "image/jpeg")
})

test("local image normalization produces a data URI and rejects unsupported files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ligvs-attachment-"))
	try {
		const image = path.join(root, "pixel.png")
		const text = path.join(root, "notes.txt")
		fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
		fs.writeFileSync(text, "not an image")
		assert.equal(await normalizeSdkImageInput(image), "data:image/png;base64,iVBORw==")
		assert.equal(await normalizeSdkImageInput(text), "")
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test("usage normalization accepts SDK naming variants and marks empty snapshots unreliable", () => {
	assert.deepEqual(normalizeUsageSnapshot({ promptTokens: 10, completionTokens: 4, cache_read_tokens: 2, cost: 0.25 }), {
		inputTokens: 10,
		outputTokens: 4,
		cacheReadTokens: 2,
		cacheWriteTokens: undefined,
		totalCost: 0.25,
		reliable: true,
	})
	assert.equal(normalizeUsageSnapshot({}).reliable, false)
})

test("task history projection owns SDK metadata and deleted-item filtering", () => {
	const projected = sdkSessionToHistoryItem({
		sessionId: "session-1",
		createdAt: 123,
		messageCount: 5,
		metadata: { title: "<lig-vs-mcp-context>legacy</lig-vs-mcp-context>Task", usage: { inputTokens: 7, outputTokens: 3 } },
	})
	assert.equal(projected.id, "session-1")
	assert.equal(projected.task, "Task")
	assert.equal(projected.tokensIn, 7)
	assert.equal(projected.tokensOut, 3)
	assert.deepEqual(removeDeletedHistoryItems([projected, createHistoryItem("session-2", "Other", "C:\\work", "model")], new Set(["session-1"])).map((item) => item.id), ["session-2"])
})

test("completion extraction prefers normalized final result fields and content blocks", () => {
	assert.equal(extractCompletionTextFromResult({ finalResponse: "  completed  " }, { text: "fallback" }), "completed")
	assert.equal(completionCandidateToText({ content: [{ type: "text", text: "first" }, { type: "tool_use", text: "hidden" }, "second"] }), "first\n\nsecond")
	assert.equal(extractCompletionTextFromResult({}, { output: { answer: "event result" } }), "event result")
})

test("transcript text policy handles deltas, tools, reasoning, and Korean tokens", () => {
	assert.equal(mergeTextDelta("hello", " world"), "hello world")
	assert.equal(mergeTextDelta("hello world", " world"), "hello world")
	assert.equal(normalizeTranscriptText(" hello\n  world "), "hello world")
	assert.equal(isToolTranscript("Tool: read_file"), true)
	assert.equal(looksLikeReasoningNarration("We need to inspect the runtime"), true)
	assert.equal(looksLikeTokenizedReasoning(["사용자", "요청을", "먼저", "확인", "해야", "합니다"]), true)
})
