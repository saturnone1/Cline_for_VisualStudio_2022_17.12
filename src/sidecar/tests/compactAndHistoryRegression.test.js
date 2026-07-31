const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskRpcHandler } = require("../dist/features/chat/TaskRpcHandler")
const { TaskHistorySync } = require("../dist/features/taskHistory/TaskHistorySync")
const { TaskTranscriptHydrator, reconcileTranscriptMessages } = require("../dist/features/taskHistory/TaskTranscriptHydrator")
const { AgentLifecycleEventProjector } = require("../dist/infrastructure/conversation/AgentLifecycleEventProjector")
const { AgentSnapshotEventProjector } = require("../dist/infrastructure/conversation/AgentSnapshotEventProjector")
const { RuntimeStatusEventProjector } = require("../dist/infrastructure/conversation/RuntimeStatusEventProjector")
const { TaskCompletionProjector } = require("../dist/infrastructure/conversation/TaskCompletionProjector")
const { AgentRunRecoveryFlow } = require("../dist/features/chat/runtime/AgentRunRecoveryFlow")
const { sdkMessagesToClineMessages } = require("../dist/infrastructure/conversation/SdkMessageTranscriptProjection")
const { agentChunkToTranscriptText } = require("../dist/infrastructure/conversation/AgentChunkTranscriptConversion")
const { isLegacyTransientRuntimeMessage } = require("../dist/application/services/TransientRuntimeMessagePolicy")
const { validateWebviewRpcPayload } = require("../dist/application/dto/generated/WebviewRpcContract")
const { decodeTaskRpcCommand } = require("../dist/infrastructure/webview/TaskRpcDecoder")
const { taskTranscriptStorageBytes } = require("../dist/features/taskHistory/TaskHistoryStorageSize")
const { buildCompactedConversationMessages } = require("../dist/infrastructure/conversation/ResumedConversationProjection")
const { RuntimeModelContext } = require("../dist/infrastructure/models/RuntimeModelContext")

test("compact and history requests satisfy their WebView RPC contracts", () => {
	assert.deepEqual(validateWebviewRpcPayload("SlashService", "condense", "request", {}), { ok: true })
	assert.deepEqual(
		validateWebviewRpcPayload("TaskService", "getTaskHistory", "request", {
			favoritesOnly: false,
			searchQuery: "old task",
			sortBy: "newest",
			currentWorkspaceOnly: false,
		}),
		{ ok: true },
	)
})

test("task history RPC waits for SDK refresh before returning tasks", async () => {
	const history = []
	const handler = new TaskRpcHandler({
		hasPendingQuestion: () => false,
		hasCurrentTask: () => false,
		start: async () => {}, respond: async () => {}, compact: async () => {}, cancel: async () => {}, clear: async () => {},
		refreshHistory: async () => { await Promise.resolve(); history.push({ id: "remote-1", task: "restored" }) },
		history: () => history,
		currentWorkspace: async () => "C:\\repo",
		show: async () => {}, delete: async () => {}, deleteAll: async () => {}, toggleFavorite: () => {}, broadcast: async () => {},
		operationHistoryLimit: () => 32,
	})

	assert.deepEqual(await handler.handle({ type: "history", query: { favoritesOnly: false, searchQuery: "", sortBy: "newest", currentWorkspaceOnly: false } }, "history-request"), {
		payload: { tasks: [{ id: "remote-1", task: "restored" }], nextCursor: -1, total: 1 },
	})
})

test("a duplicate new-task request is ignored while the first task is starting", async () => {
	let starts = 0
	let responses = 0
	const handler = new TaskRpcHandler({
		hasPendingQuestion: () => false,
		hasCurrentTask: () => true,
		isStarting: () => true,
		start: async () => { starts++ }, respond: async () => { responses++ }, compact: async () => {}, cancel: async () => {}, clear: async () => {},
		refreshHistory: async () => {}, history: () => [], currentWorkspace: async () => "C:\\repo",
		show: async () => {}, delete: async () => {}, deleteAll: async () => {}, toggleFavorite: async () => {}, broadcast: async () => {},
		operationHistoryLimit: () => 32,
	})

	assert.deepEqual(await handler.handle({ type: "newTask", request: { text: "duplicate", images: [], files: [] } }, "duplicate"), {
		payload: {}, includeStateMessages: true,
	})
	assert.equal(starts, 0)
	assert.equal(responses, 0)
})

test("a client operation is applied once even after the task leaves starting state", async () => {
	let responses = 0
	const handler = new TaskRpcHandler({
		hasPendingQuestion: () => false, hasCurrentTask: () => true, isStarting: () => false,
		start: async () => {}, respond: async () => { responses++ }, compact: async () => {}, cancel: async () => {}, clear: async () => {},
		refreshHistory: async () => {}, history: () => [], currentWorkspace: async () => "C:\\repo",
		show: async () => {}, delete: async () => {}, deleteAll: async () => {}, toggleFavorite: async () => {}, broadcast: async () => {}, operationHistoryLimit: () => 32,
	})
	const request = { text: "hello", answerText: "", responseType: "", images: [], files: [], workspacePath: "", delivery: "", clientOperationId: "operation-1" }
	await handler.handle({ type: "newTask", request }, "request-1")
	await handler.handle({ type: "newTask", request }, "request-2")
	assert.equal(responses, 1)
})

test("task history decoder applies server-owned filters, search, and ordering", async () => {
	const history = [
		{ id: "1", task: "Alpha review", ts: 1, isFavorited: true, cwdOnTaskInitialization: "C:\\repo", size: 120 },
		{ id: "2", task: "Alpha elsewhere", ts: 3, isFavorited: true, cwdOnTaskInitialization: "D:\\other", size: 80 },
		{ id: "3", task: "Beta review", ts: 2, isFavorited: false, cwdOnTaskInitialization: "C:\\repo", size: 40 },
	]
	const handler = new TaskRpcHandler({
		hasPendingQuestion: () => false, hasCurrentTask: () => false,
		start: async () => {}, respond: async () => {}, compact: async () => {}, cancel: async () => {}, clear: async () => {},
		refreshHistory: async () => {}, history: () => history, currentWorkspace: async () => "c:/repo/",
		show: async () => {}, delete: async () => {}, deleteAll: async () => {}, toggleFavorite: () => {}, broadcast: async () => {},
		operationHistoryLimit: () => 32,
	})
	const command = decodeTaskRpcCommand("TaskService.getTaskHistory", {
		favoritesOnly: true, searchQuery: "alpha", sortBy: "oldest", currentWorkspaceOnly: true,
	})

	assert.deepEqual(await handler.handle(command, "filtered-history"), { payload: { tasks: [history[0]], nextCursor: -1, total: 1 } })
	assert.deepEqual(await handler.handle({ type: "historySize" }, "history-size"), { payload: { value: 240 } })
	const searched = await handler.handle({ type: "history", query: { favoritesOnly: false, searchQuery: "Alph revie", sortBy: "newest", currentWorkspaceOnly: false } }, "searched-history")
	assert.deepEqual(searched.payload, { tasks: [history[0]], nextCursor: -1, total: 1 })
})

test("task history storage size measures serialized UTF-8 bytes instead of message count", () => {
	const messages = [{ type: "say", text: "안녕" }]
	assert.equal(taskTranscriptStorageBytes(messages), Buffer.byteLength(JSON.stringify(messages), "utf8"))
	assert.ok(taskTranscriptStorageBytes(messages) > messages.length)
})

test("SDK history refresh preserves local tasks that are absent from the SDK result", async () => {
	let history = [{ id: "local-1", task: "legacy local task" }]
	const sync = new TaskHistorySync({
		isAvailable: () => true,
		listHistory: async () => [{ sessionId: "remote-1", title: "SDK task" }],
		projectSession: (session) => ({ id: session.sessionId, task: session.title }),
		readHistory: () => history,
		writeHistory: (next) => { history = next },
		broadcast: async () => {},
		log: () => {},
	})

	await sync.refresh()
	assert.deepEqual(history.map((item) => item.id), ["remote-1", "local-1"])
})

test("compaction preserves the latest user request and completed result under a small context budget", () => {
	const messages = [
		{ type: "say", say: "task", text: "안녕" },
		{ type: "say", say: "text", text: "안녕하세요" },
		{ type: "say", say: "user_feedback", text: "이 프로젝트를 검토해봐" },
		...Array.from({ length: 12 }, (_, index) => ({ type: "say", say: "tool", text: `도구 결과 ${index} ${"x".repeat(500)}` })),
		{ type: "say", say: "text", text: `빌드 결과와 프로젝트 구조를 검토했습니다. ${"세부 분석 ".repeat(500)}` },
	]

	const compacted = buildCompactedConversationMessages(messages)
	const serialized = JSON.stringify(compacted)
	assert.match(serialized, /이 프로젝트를 검토해봐/)
	assert.match(serialized, /빌드 결과와 프로젝트 구조를 검토했습니다/)
	assert.ok(compacted.some((message) => message.role === "user" && message.content === "이 프로젝트를 검토해봐"))
	assert.match(serialized, /도구 결과 0/)
})

test("first compaction preserves chronological middle decisions instead of semantic sampling", () => {
	const messages = [
		{ type: "say", say: "task", text: "start" },
		{ type: "say", say: "user_feedback", text: "middle decision: use protocol alpha" },
		{ type: "say", say: "text", text: "acknowledged alpha" },
		{ type: "say", say: "user_feedback", text: "finish" },
	]
	assert.match(JSON.stringify(buildCompactedConversationMessages(messages)), /middle decision: use protocol alpha/)
})

test("configured context tokens provide a model-relative token budget for resumed conversation", () => {
	const context = new RuntimeModelContext({
		configuration: () => ({ actModeApiProvider: "ollama", actModeOllamaModelId: "model", ollamaApiOptionsCtxNum: "4096" }),
		mode: () => "act",
		defaultModelId: () => "",
		defaultOllamaModelId: () => "model",
	})

	assert.equal(context.resumedConversationTokenBudget(), 2_457)
})

test("a repeated compaction chains the stored summary with only post-boundary conversation", () => {
	const messages = [
		{ type: "say", say: "task", text: "old raw request that must not be recompressed" },
		{ type: "say", say: "text", text: "old raw answer that must not be recompressed" },
		{ type: "say", say: "info", text: "compacted", contextCompaction: { sessionId: "new", summary: "durable compressed state" } },
		{ type: "say", say: "user_feedback", text: "new request after compaction" },
		{ type: "say", say: "text", text: "new result after compaction" },
	]

	const compacted = buildCompactedConversationMessages(messages)
	const serialized = JSON.stringify(compacted)
	assert.match(serialized, /durable compressed state/)
	assert.match(serialized, /new request after compaction/)
	assert.match(serialized, /new result after compaction/)
	assert.doesNotMatch(serialized, /old raw request/)
	assert.doesNotMatch(serialized, /old raw answer/)
	assert.equal(compacted[0].role, "context")
	assert.equal(compacted.some((message) => message.role === "assistant" && /loaded|restored/i.test(message.content)), false)
})

test("active transcript reconciliation appends a missed final response and replaces its partial", () => {
	const current = [
		{ type: "say", say: "task", text: "검토해" },
		{ type: "say", say: "text", text: "검토 결과", partial: true },
	]
	const projected = [
		{ type: "say", say: "task", text: "검토해" },
		{ type: "say", say: "text", text: "검토 결과입니다." },
	]
	const result = reconcileTranscriptMessages(current, projected)
	assert.equal(result.changed, true)
	assert.deepEqual(result.messages, [current[0], { ...projected[1], partial: undefined }])
})

test("transcript reconciliation treats task and user feedback as the same user turn", () => {
	const current = [
		{ ts: 101, type: "say", say: "user_feedback", text: "기능을 다시 실행해" },
		{ ts: 200, type: "say", say: "text", text: "실행 결과" },
		{ ts: 201, type: "say", say: "completion_result", text: "완료" },
	]
	const projected = [
		{ ts: 100, type: "say", say: "task", text: "기능을 다시 실행해" },
		{ ts: 200, type: "say", say: "text", text: "실행 결과" },
	]
	const result = reconcileTranscriptMessages(current, projected)
	assert.equal(result.changed, false)
	assert.deepEqual(result.messages, current)
})

test("transcript reconciliation preserves repeated user turns by occurrence count", () => {
	const current = [{ ts: 100, type: "say", say: "user_feedback", text: "다시 해봐" }]
	const projected = [
		{ ts: 100, type: "say", say: "task", text: "다시 해봐" },
		{ ts: 200, type: "say", say: "user_feedback", text: "다시 해봐" },
	]
	const result = reconcileTranscriptMessages(current, projected)
	assert.equal(result.changed, true)
	assert.equal(result.messages.length, 2)
	assert.equal(result.messages[1].ts, 200)
})

test("selected task refresh reconciles while an SDK session is active without marking completion", async () => {
	let applied
	let reconciledStatus
	const hydrator = new TaskTranscriptHydrator({
		isAvailable: () => true,
		readCurrentTask: () => ({ id: "session-1", task: "검토" }),
		activeSessionId: () => "session-1",
		hasLiveProjection: () => true,
		readMessages: () => [{ type: "say", say: "task", text: "검토해" }],
		loadTranscript: async () => ({ session: { sessionId: "session-1", status: "completed" }, messages: [{ role: "user", content: "검토해" }, { role: "assistant", content: "완료 결과" }] }),
		activateTranscript: async () => { throw new Error("not used") },
		getSnapshot: () => null,
		prepareActivation: () => {}, clearLiveInteraction: () => {},
		projectSession: () => ({ id: "session-1", task: "검토" }),
		projectMessages: () => [{ type: "say", say: "task", text: "검토해" }, { type: "say", say: "text", text: "완료 결과" }],
		applySelected: (_id, _task, messages) => { applied = messages },
		applyShown: () => {}, applyHydrated: () => {},
		reconcileSession: (_id, status) => { reconciledStatus = status },
		summarizeMessage: () => ({}), log: () => {}, broadcast: async () => {}, isSessionNotFound: () => false,
	})

	await hydrator.refreshSelected()
	assert.equal(reconciledStatus, "completed")
	assert.equal(applied.at(-1).text, "완료 결과")
	assert.equal(applied.some((message) => message.say === "completion_result"), false)
})

test("compacted SDK bootstrap messages stay out of the visible transcript", async () => {
	let projectedInput
	const hydrator = new TaskTranscriptHydrator({
		isAvailable: () => true,
		readCurrentTask: () => ({ id: "session-2", task: "continued" }),
		activeSessionId: () => "session-2",
		hasLiveProjection: () => true,
		readMessages: () => [],
		loadTranscript: async () => ({
			session: {
				sessionId: "session-2",
				status: "active",
				metadata: { ligVsContextCompaction: true, ligVsCompactedInitialMessageCount: 2 },
			},
			messages: [
				{ role: "user", content: "internal compacted summary" },
				{ role: "assistant", content: "internal bootstrap acknowledgement" },
				{ role: "user", content: "visible follow-up" },
			],
		}),
		activateTranscript: async () => { throw new Error("not used") },
		getSnapshot: () => null,
		prepareActivation: () => {}, clearLiveInteraction: () => {},
		projectSession: () => ({ id: "session-2", task: "continued" }),
		projectMessages: (messages) => { projectedInput = messages; return [{ type: "say", say: "task", text: "visible follow-up" }] },
		applySelected: () => {}, applyShown: () => {}, applyHydrated: () => {}, reconcileSession: () => {},
		summarizeMessage: () => ({}), log: () => {}, broadcast: async () => {}, isSessionNotFound: () => false,
	})

	await hydrator.refreshSelected()
	assert.deepEqual(projectedInput, [{ role: "user", content: "visible follow-up" }])
})

test("resumed SDK bootstrap history stays out of the visible transcript", async () => {
	let projectedInput
	const hydrator = new TaskTranscriptHydrator({
		isAvailable: () => true,
		readCurrentTask: () => ({ id: "replacement", task: "다시 해봐" }),
		activeSessionId: () => "replacement",
		hasLiveProjection: () => true,
		readMessages: () => [],
		loadTranscript: async () => ({
			session: { sessionId: "replacement", status: "idle", prompt: "다시 해봐", metadata: { ligVsResumed: true, ligVsResumedFrom: "source" } },
			messages: [
				{ role: "user", content: "이전 요청" },
				{ role: "assistant", content: "이전 응답" },
				{ role: "user", content: [{ type: "text", text: '<user_input mode="act">다시 해봐</user_input>' }] },
				{ role: "assistant", content: "새 응답" },
			],
		}),
		activateTranscript: async () => { throw new Error("not used") },
		getSnapshot: () => null,
		prepareActivation: () => {}, clearLiveInteraction: () => {},
		projectSession: () => ({ id: "replacement", task: "다시 해봐" }),
		projectMessages: (messages) => { projectedInput = messages; return [] },
		applySelected: () => {}, applyShown: () => {}, applyHydrated: () => {}, reconcileSession: () => {},
		summarizeMessage: () => ({}), log: () => {}, broadcast: async () => {}, isSessionNotFound: () => false,
	})

	await hydrator.refreshSelected()
	assert.deepEqual(projectedInput, [
		{ role: "user", content: [{ type: "text", text: '<user_input mode="act">다시 해봐</user_input>' }] },
		{ role: "assistant", content: "새 응답" },
	])
})

test("SDK user input envelopes project as the original user text", () => {
	const messages = sdkMessagesToClineMessages([
		{ role: "user", content: [{ type: "text", text: '<user_input mode="act">?</user_input>' }] },
	], { id: "session-envelope", task: "?" })

	assert.equal(messages.length, 1)
	assert.equal(messages[0].say, "task")
	assert.equal(messages[0].text, "?")
})

test("SDK transcript hydration keeps user attachments out of the visible text", () => {
	const messages = sdkMessagesToClineMessages([
		{
			role: "user",
			content: [
				{ type: "text", text: '<user_input mode="act">이미지와 파일을 검토해줘</user_input>' },
				{ type: "image", data: "aW1hZ2U=", mediaType: "image/png" },
				{ type: "file", path: "C:\\workspace\\notes.txt", content: "notes" },
			],
		},
	], { id: "session-attachments", task: "이미지와 파일을 검토해줘" })

	assert.equal(messages.length, 1)
	assert.equal(messages[0].text, "이미지와 파일을 검토해줘")
	assert.deepEqual(messages[0].images, ["data:image/png;base64,aW1hZ2U="])
	assert.deepEqual(messages[0].files, ["C:\\workspace\\notes.txt"])
})

test("transcript reconciliation repairs previously persisted SDK user input envelopes", () => {
	const result = reconcileTranscriptMessages(
		[{ type: "say", say: "user_feedback", text: '<user_input mode="act">?</user_input>' }],
		[{ type: "say", say: "user_feedback", text: "?" }],
	)

	assert.equal(result.changed, true)
	assert.deepEqual(result.messages, [{ type: "say", say: "user_feedback", text: "?" }])
})

test("legacy resume bootstrap detection does not mistake a later tool result for the current prompt", async () => {
	let projectedInput
	const hydrator = new TaskTranscriptHydrator({
		isAvailable: () => true, readCurrentTask: () => ({ id: "replacement", task: "다시 해봐" }), activeSessionId: () => "replacement",
		hasLiveProjection: () => true, readMessages: () => [],
		loadTranscript: async () => ({
			session: { sessionId: "replacement", status: "idle", prompt: "다시 해봐", metadata: { ligVsResumed: true } },
			messages: [
				{ role: "user", content: "이전 요청" },
				{ role: "user", content: [{ type: "text", text: '<user_input mode="act">다시 해봐</user_input>' }] },
				{ role: "assistant", content: "진행 중" },
				{ role: "user", content: "Tool result: 사용자가 다시 해봐라고 요청함" },
				{ role: "assistant", content: "최종 응답" },
			],
		}),
		activateTranscript: async () => { throw new Error("not used") }, getSnapshot: () => null, prepareActivation: () => {}, clearLiveInteraction: () => {},
		projectSession: () => ({ id: "replacement", task: "다시 해봐" }), projectMessages: (messages) => { projectedInput = messages; return [] },
		applySelected: () => {}, applyShown: () => {}, applyHydrated: () => {}, reconcileSession: () => {}, summarizeMessage: () => ({}), log: () => {}, broadcast: async () => {}, isSessionNotFound: () => false,
	})
	await hydrator.refreshSelected()
	assert.equal(projectedInput.length, 4)
	assert.equal(projectedInput.at(-1).content, "최종 응답")
})

test("AgentError projects an error and terminates the task as failed", () => {
	const calls = []
	const projector = new AgentLifecycleEventProjector({
		noteActivity: () => {}, clearReasoning: () => {}, finishToolActivity: () => {}, finishProgress: () => {},
		finalizePartial: () => {}, addText: () => {}, addError: (text) => calls.push(["error", text]),
		finishTask: (sessionId, status) => calls.push(["finish", sessionId, status]),
		updateUsage: () => {}, recordContextUsage: () => {}, hasCompletion: () => false,
		activePartialText: () => "", hasAssistantAfterUser: () => false, log: () => {},
		formatError: (error) => String(error.message || error), markErrorLatency: () => {},
		quarantineSession: (sessionId) => calls.push(["quarantine", sessionId]),
	})

	projector.handle({ type: "AgentError", sessionId: "session-1", error: new Error("provider failed"), recoverable: false })
	assert.deepEqual(calls, [["error", "provider failed"], ["quarantine", "session-1"], ["finish", "session-1", "failed"]])
})

test("recoverable AgentError remains in the active run", () => {
	const calls = []
	const projector = new AgentLifecycleEventProjector({
		noteActivity: (reason) => calls.push(["activity", reason]), clearReasoning: () => {}, finishToolActivity: () => {}, finishProgress: () => calls.push(["finishProgress"]),
		finalizePartial: () => {}, addText: () => {}, addError: (text) => calls.push(["error", text]),
		finishTask: (sessionId, status) => calls.push(["finish", sessionId, status]),
		updateUsage: () => {}, recordContextUsage: () => {}, hasCompletion: () => false,
		activePartialText: () => "", hasAssistantAfterUser: () => false, log: (event) => calls.push(["log", event]),
		formatError: (error) => String(error.message || error), markErrorLatency: () => {},
		quarantineSession: (sessionId) => calls.push(["quarantine", sessionId]),
	})

	projector.handle({ type: "AgentError", sessionId: "session-1", error: new Error("retrying"), recoverable: true, iteration: 2 })
	assert.deepEqual(calls, [["activity", "recoverable-error"], ["log", "recoverableAgentError"]])
})

test("native SDK compaction notices use top-level SDK metadata without adding chat text", () => {
	const phases = []
	const texts = []
	const projector = new AgentLifecycleEventProjector({
		noteActivity: () => {}, clearReasoning: () => {}, finishToolActivity: () => {}, finishProgress: () => {},
		finalizePartial: () => {}, addText: (text) => texts.push(text), addError: () => {}, finishTask: () => {},
		updateUsage: () => {}, recordContextUsage: () => {}, hasCompletion: () => false,
		activePartialText: () => "", hasAssistantAfterUser: () => false, log: () => {},
		formatError: String, markErrorLatency: () => {}, quarantineSession: () => {},
		setCompactionStatus: (notice) => phases.push(notice),
	})

	projector.handle({ type: "NoticeReceived", sessionId: "session-1", message: "auto-compacting", reason: "auto_compaction", noticeType: "status", raw: { phase: "started", maxInputTokens: 8192, triggerTokens: 7373, targetTokens: 5734, messageTargetTokens: 4096 } })
	projector.handle({ type: "NoticeReceived", sessionId: "session-1", message: "auto-compacted", reason: "auto_compaction", noticeType: "status", raw: { phase: "completed", tokensBefore: 7600, tokensAfter: 3200, messagesBefore: 12, messagesAfter: 4, maxInputTokens: 8192 } })

	assert.deepEqual(phases, [
		{ phase: "started", sessionId: "session-1", reason: "auto_compaction", maxInputTokens: 8192, triggerTokens: 7373, targetTokens: 5734, messageTargetTokens: 4096 },
		{ phase: "completed", sessionId: "session-1", reason: "auto_compaction", tokensBefore: 7600, tokensAfter: 3200, messagesBefore: 12, messagesAfter: 4, maxInputTokens: 8192 },
	])
	assert.deepEqual(texts, [])
	assert.equal(agentChunkToTranscriptText({ type: "notice", message: "auto-compacting", reason: "auto_compaction", phase: "started" }), "")
	assert.equal(agentChunkToTranscriptText({ type: "notice", message: "auto-compacted", kind: "auto_compaction", phase: "completed" }), "")
	assert.equal(agentChunkToTranscriptText({ type: "notice", message: "compaction-budget-adjusted", reason: "compaction_budget_emergency" }), "")
})

test("terminal SDK events always clear an unfinished compaction state", () => {
	const phases = []
	const finishes = []
	const projector = new AgentLifecycleEventProjector({
		noteActivity: () => {}, clearReasoning: () => {}, finishToolActivity: () => {}, finishProgress: () => {},
		finalizePartial: () => {}, addText: () => {}, addError: () => {}, finishTask: (sessionId, status) => finishes.push([sessionId, status]),
		updateUsage: () => {}, recordContextUsage: () => {}, hasCompletion: () => false,
		activePartialText: () => "", hasAssistantAfterUser: () => false, log: () => {},
		formatError: String, markErrorLatency: () => {}, quarantineSession: () => {},
		setCompactionStatus: (notice) => phases.push(notice.phase),
	})

	projector.handle({ type: "NoticeReceived", sessionId: "done", message: "auto-compacting", reason: "auto_compaction", noticeType: "status", raw: { phase: "started" } })
	projector.handle({ type: "AgentDone", sessionId: "done", reason: "completed", result: {}, completion: {} })
	projector.handle({ type: "NoticeReceived", sessionId: "failed", message: "auto-compacting", reason: "auto_compaction", noticeType: "status", raw: { phase: "started" } })
	projector.handle({ type: "AgentError", sessionId: "failed", error: new Error("provider failed"), recoverable: false })

	assert.deepEqual(phases, ["started", "idle", "started", "idle"])
	assert.deepEqual(finishes, [["done", "completed"], ["failed", "failed"]])
})

test("legacy SDK compaction status rows are removed without hiding ordinary conversation", () => {
	assert.equal(isLegacyTransientRuntimeMessage({ type: "say", say: "text", text: "auto-compacting" }), true)
	assert.equal(isLegacyTransientRuntimeMessage({ type: "say", say: "text", text: "compaction-budget-adjusted" }), true)
	assert.equal(isLegacyTransientRuntimeMessage({ type: "say", say: "text", text: " auto-compacted " }), true)
	assert.equal(isLegacyTransientRuntimeMessage({ type: "say", say: "text", text: "auto-compaction-skipped" }), true)
	assert.equal(isLegacyTransientRuntimeMessage({ type: "say", say: "text", text: "왜 auto-compaction-skipped 됐지?" }), false)
	assert.equal(isLegacyTransientRuntimeMessage({ type: "say", say: "task", text: "auto-compacting" }), false)
	assert.equal(isLegacyTransientRuntimeMessage({ type: "say", say: "text", text: "auto-compacting", files: ["note.txt"] }), false)

	const reconciled = reconcileTranscriptMessages([
		{ type: "say", say: "text", text: "auto-compacting" },
		{ type: "say", say: "text", text: "정상 응답" },
	], [])
	assert.equal(reconciled.changed, true)
	assert.deepEqual(reconciled.messages, [{ type: "say", say: "text", text: "정상 응답" }])
})

test("parallel SDK error chunks do not duplicate canonical errors or render object Object", () => {
	assert.equal(agentChunkToTranscriptText({ type: "error", error: { message: "invalid tool arguments" } }), "")
})

test("transcript reconciliation removes persisted object-coercion placeholders", () => {
	const result = reconcileTranscriptMessages(
		[{ type: "say", say: "text", text: "[object Object]" }],
		[],
	)

	assert.equal(result.changed, true)
	assert.deepEqual(result.messages, [])
})

test("AgentDone maps SDK terminal reasons instead of treating every stop as success", () => {
	const finishes = []
	const projector = new AgentLifecycleEventProjector({
		noteActivity: () => {}, clearReasoning: () => {}, finishToolActivity: () => {}, finishProgress: () => {},
		finalizePartial: () => {}, addText: () => {}, addError: () => {}, finishTask: (sessionId, status) => finishes.push([sessionId, status]),
		updateUsage: () => {}, recordContextUsage: () => {}, hasCompletion: () => false, activePartialText: () => "", hasAssistantAfterUser: () => false,
		log: () => {}, formatError: String, markErrorLatency: () => {}, quarantineSession: () => {},
	})

	projector.handle({ type: "AgentDone", sessionId: "mistake", reason: "mistake_limit", result: {}, completion: {} })
	projector.handle({ type: "AgentDone", sessionId: "aborted", reason: "aborted", result: {}, completion: {} })
	projector.handle({ type: "AgentDone", sessionId: "complete", reason: "completed", result: {}, completion: {} })
	assert.deepEqual(finishes, [["mistake", "failed"], ["aborted", "cancelled"], ["complete", "completed"]])
})

test("RunFailed preserves the SDK failure reason instead of leaving only tool JSON", () => {
	const calls = []
	const projector = new AgentLifecycleEventProjector({
		noteActivity: () => {}, clearReasoning: () => {}, finishToolActivity: () => {}, finishProgress: () => {},
		finalizePartial: () => {}, addText: () => {}, addError: (text) => calls.push(["error", text]),
		finishTask: (sessionId, status) => calls.push(["finish", sessionId, status]),
		updateUsage: () => {}, recordContextUsage: () => {}, hasCompletion: () => false,
		activePartialText: () => "", hasAssistantAfterUser: () => false, log: () => {},
		formatError: (error) => String(error.message || error), markErrorLatency: () => {},
		quarantineSession: (sessionId) => calls.push(["quarantine", sessionId]),
	})

	projector.handle({ type: "RunFailed", sessionId: "session-1", reason: "MCP server unavailable" })
	assert.deepEqual(calls, [["error", "MCP server unavailable"], ["quarantine", "session-1"], ["finish", "session-1", "failed"]])
})

test("run recovery ignores a late rejection after terminal state", async () => {
	let hydrateCalls = 0
	let failureCalls = 0
	const flow = new AgentRunRecoveryFlow({
		currentGeneration: () => 1, isTerminal: () => true, activeText: () => "", hasAssistantText: () => false,
		hydrate: async () => { hydrateCalls++; return true }, sessionStatus: async () => "completed", finishTask: () => {}, updateTask: () => {},
		broadcast: async () => {}, projectFailure: () => { failureCalls++ }, log: () => {},
	})

	await flow.recover("session-1", "run", 1, new Error("late rejection"))
	assert.equal(hydrateCalls, 0)
	assert.equal(failureCalls, 0)
})

test("run recovery defers failure while the SDK session remains active", async () => {
	let hydrateCalls = 0
	let failed = 0
	let broadcasts = 0
	const flow = new AgentRunRecoveryFlow({
		currentGeneration: () => 1, isTerminal: () => false,
		activeText: () => "partial response",
		hasAssistantText: () => false,
		hydrate: async () => { hydrateCalls++; return false }, sessionStatus: async () => "running",
		finishTask: () => {}, updateTask: () => {}, broadcast: async () => { broadcasts++ },
		projectFailure: () => { failed++ }, log: () => {},
	})

	await flow.recover("session-1", "run", 1, new Error("transport closed"))
	assert.equal(hydrateCalls, 1)
	assert.equal(failed, 0)
	assert.equal(broadcasts, 1)
})

test("run recovery preserves partial output but reports failure without a terminal event", async () => {
	let failed = 0
	let finished = 0
	const flow = new AgentRunRecoveryFlow({
		currentGeneration: () => 1, isTerminal: () => false,
		activeText: () => "unfinished partial response", hasAssistantText: () => true,
		hydrate: async () => false, sessionStatus: async () => "failed", finishTask: () => { finished++ }, updateTask: () => {}, broadcast: async () => {},
		projectFailure: () => { failed++ }, log: () => {},
	})

	await flow.recover("session-1", "run", 1, new Error("transport closed"))
	assert.equal(finished, 0)
	assert.equal(failed, 1)
})

test("idle observations do not complete an active run", () => {
	let finishes = 0
	const status = new RuntimeStatusEventProjector({
		shouldIgnore: () => false, markFirstEvent: () => {}, activeText: () => "", finishTask: () => { finishes++ },
		updateTask: () => {}, broadcast: () => {}, transitionStreaming: () => {}, noteActivity: () => {}, schedulePartial: () => {}, log: () => {},
	})
	const snapshot = new AgentSnapshotEventProjector({
		bindSession: () => {}, finishTask: () => { finishes++ }, noteActivity: () => {}, activeText: () => "",
		updateTask: () => {}, broadcast: () => {},
	})
	status.handle({ type: "status", sessionId: "session-1", status: "idle" })
	snapshot.handle({ type: "session_snapshot", sessionId: "session-1", status: "idle", usage: {} })
	assert.equal(finishes, 0)
})

test("completion without final text or tool evidence is not reported as success", () => {
	const messages = [{ type: "say", say: "task", text: "hello" }]
	let hooks = 0
	const projector = new TaskCompletionProjector({
		messages: () => messages, transition: () => {}, clearFinishStatus: () => {}, finishProgress: () => {}, prepareAssistant: () => {},
		activeText: () => "", addMessage: (message) => messages.push(message), markAssistantLatency: () => {}, finalizeOpenPartial: () => {},
		lastActivityReason: () => "ended", runCompleteHook: () => { hooks++ }, capture: () => {}, persist: () => {}, language: () => "en",
		recentToolSummaries: () => [], log: () => {},
	})
	projector.finish("session-1", "completed")
	assert.equal(messages.at(-1).say, "error")
	assert.match(messages.at(-1).text, /without a final response/)
	assert.equal(hooks, 1)
})

test("completion after a tool result supplies a visible evidence summary when final text is missing", () => {
	const messages = [{ type: "say", say: "task", text: "capture" }, { type: "say", say: "browser_action", text: "{}" }]
	const projector = new TaskCompletionProjector({
		messages: () => messages, transition: () => {}, clearFinishStatus: () => {}, finishProgress: () => {}, prepareAssistant: () => {},
		activeText: () => "", addMessage: (message) => messages.push(message), markAssistantLatency: () => {}, finalizeOpenPartial: () => {},
		lastActivityReason: () => "browser", runCompleteHook: () => {}, capture: () => {}, persist: () => {}, language: () => "en",
		recentToolSummaries: () => ["Browser screenshot ok: Example"], log: () => {},
	})
	projector.finish("session-1", "completed")
	assert.equal(messages.at(-2).say, "text")
	assert.match(messages.at(-2).text, /Browser screenshot ok: Example/)
	assert.equal(messages.at(-1).say, "completion_result")
})
