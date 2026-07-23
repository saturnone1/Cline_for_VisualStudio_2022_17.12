const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskRpcHandler } = require("../dist/features/chat/TaskRpcHandler")
const { CompactSessionFlow } = require("../dist/features/chat/runtime/CompactSessionFlow")
const { isContextOverflowError } = require("../dist/features/chat/runtime/ContextOverflowError")
const { TaskHistorySync } = require("../dist/features/taskHistory/TaskHistorySync")
const { TaskTranscriptHydrator, reconcileTranscriptMessages } = require("../dist/features/taskHistory/TaskTranscriptHydrator")
const { AgentLifecycleEventProjector } = require("../dist/infrastructure/conversation/AgentLifecycleEventProjector")
const { AgentSnapshotEventProjector } = require("../dist/infrastructure/conversation/AgentSnapshotEventProjector")
const { RuntimeStatusEventProjector } = require("../dist/infrastructure/conversation/RuntimeStatusEventProjector")
const { TaskCompletionProjector } = require("../dist/infrastructure/conversation/TaskCompletionProjector")
const { AgentRunRecoveryFlow } = require("../dist/features/chat/runtime/AgentRunRecoveryFlow")
const { validateWebviewRpcPayload } = require("../dist/application/dto/generated/WebviewRpcContract")
const { decodeTaskRpcCommand } = require("../dist/infrastructure/webview/TaskRpcDecoder")
const { taskTranscriptStorageBytes } = require("../dist/features/taskHistory/TaskHistoryStorageSize")
const { buildCompactedConversationMessages } = require("../dist/infrastructure/conversation/ResumedConversationProjection")
const { RuntimeModelContext } = require("../dist/infrastructure/models/RuntimeModelContext")
const { resolveCompactionBudget } = require("../dist/infrastructure/sdk/ClineSdkCompactionSummarizer")

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

test("compact flow delegates validated summarization and creates a replacement SDK session", async () => {
	let compactCommand
	let applied
	const flow = new CompactSessionFlow({
		isRuntimeAvailable: () => true,
		activeSessionId: () => "stale-session",
		selectedSessionId: () => "session-1",
		language: () => "ko",
		transitionStarting: () => {},
		showProgress: () => {},
		persist: () => {},
		broadcast: async () => {},
		buildRequest: async (sourceSessionId) => ({ sourceSessionId, cwd: "C:\\repo", initialMessages: [{ role: "user", content: "summary" }], config: {}, toolPolicies: {} }),
		compact: async (command) => { compactCommand = command; return { sessionId: "session-2" } },
		result: (result) => ({ sessionId: result.sessionId, messagesAfter: result.compactedMessageCount || 3, estimatedTokensAfter: result.estimatedTokensAfter || 500, summary: result.compactionSummary || "stored summary" }),
		applySuccess: async (...args) => { applied = args },
		applyFailure: async (error) => { throw error },
		messageCount: () => 25,
		log: () => {},
	})

	assert.equal(await flow.execute("compact-request"), "session-2")
	assert.equal(compactCommand.sourceSessionId, "session-1")
	assert.equal("prompt" in compactCommand, false)
	assert.deepEqual(applied, ["session-1", { sessionId: "session-2", messagesAfter: 3, estimatedTokensAfter: 500, summary: "stored summary" }, 25, 3])
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

test("configured context tokens provide a usable character budget for Korean compaction", () => {
	const context = new RuntimeModelContext({
		configuration: () => ({ actModeApiProvider: "ollama", actModeOllamaModelId: "model", ollamaApiOptionsCtxNum: "4096" }),
		mode: () => "act",
		defaultModelId: () => "",
		defaultOllamaModelId: () => "model",
		maxResumedConversationChars: 20_000,
	})

	assert.equal(context.resumedConversationCharBudget(), 5_120)
})

test("compaction budget respects a small configured context window", () => {
	const budget = resolveCompactionBudget({ contextWindowTokens: 4096 })
	assert.equal(budget.contextTokens, 4096)
	assert.ok(budget.outputTokens < 2048)
	assert.ok(budget.inputTokens < 4096)
	assert.ok(budget.inputTokens + budget.outputTokens < budget.contextTokens)
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

test("context overflow detection excludes unrelated worker exhaustion", () => {
	assert.equal(isContextOverflowError(new Error("max_tokens must be at least 1, got -65855")), true)
	assert.equal(isContextOverflowError(new Error("maximum context length exceeded")), true)
	assert.equal(isContextOverflowError(new Error("Worker local total request limit reached (33/32)")), false)
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

test("AgentError projects an error and terminates the task as failed", () => {
	const calls = []
	const projector = new AgentLifecycleEventProjector({
		noteActivity: () => {}, clearReasoning: () => {}, finishToolActivity: () => {}, finishProgress: () => {},
		finalizePartial: () => {}, addText: () => {}, addError: (text) => calls.push(["error", text]),
		finishTask: (sessionId, status) => calls.push(["finish", sessionId, status]),
		updateUsage: () => {}, recordContextUsage: () => {}, hasCompletion: () => false,
		activePartialText: () => "", hasAssistantAfterUser: () => false, log: () => {},
		formatError: (error) => String(error.message || error), markErrorLatency: () => {},
	})

	projector.handle({ type: "AgentError", sessionId: "session-1", error: new Error("provider failed") })
	assert.deepEqual(calls, [["error", "provider failed"], ["finish", "session-1", "failed"]])
})

test("run recovery ignores a late rejection after terminal state", async () => {
	let hydrateCalls = 0
	let failureCalls = 0
	const flow = new AgentRunRecoveryFlow({
		currentGeneration: () => 1, isTerminal: () => true, activeText: () => "", hasAssistantText: () => false,
		hydrate: async () => { hydrateCalls++; return true }, finishTask: () => {}, updateTask: () => {},
		broadcast: async () => {}, projectFailure: () => { failureCalls++ }, log: () => {},
	})

	await flow.recover("session-1", "run", 1, new Error("late rejection"))
	assert.equal(hydrateCalls, 0)
	assert.equal(failureCalls, 0)
})

test("run recovery follows a deadline policy and can recover a later transcript", async () => {
	let clock = 0
	let hydrateCalls = 0
	let finished = 0
	const flow = new AgentRunRecoveryFlow({
		currentGeneration: () => 1, isTerminal: () => hydrateCalls >= 4,
		activeText: () => hydrateCalls >= 4 ? "late final response" : "",
		hasAssistantText: () => false,
		hydrate: async () => { hydrateCalls++; return hydrateCalls >= 4 },
		finishTask: () => { finished++ }, updateTask: () => {}, broadcast: async () => {},
		projectFailure: () => assert.fail("terminal hydration should recover"), log: () => {},
	}, { deadlineMs: 5_000, initialDelayMs: 100, maxDelayMs: 1_000, now: () => clock, wait: async (ms) => { clock += ms } })

	await flow.recover("session-1", "run", 1, new Error("transport closed"))
	assert.equal(finished, 0)
	assert.equal(hydrateCalls, 4)
})

test("run recovery preserves partial output but reports failure without a terminal event", async () => {
	let failed = 0
	let finished = 0
	const flow = new AgentRunRecoveryFlow({
		currentGeneration: () => 1, isTerminal: () => false,
		activeText: () => "unfinished partial response", hasAssistantText: () => true,
		hydrate: async () => false, finishTask: () => { finished++ }, updateTask: () => {}, broadcast: async () => {},
		projectFailure: () => { failed++ }, log: () => {},
	}, { deadlineMs: 0, initialDelayMs: 1, maxDelayMs: 1 })

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

test("completion without final text still emits a terminal marker and completion hook", () => {
	const messages = [{ type: "say", say: "task", text: "hello" }]
	let hooks = 0
	const projector = new TaskCompletionProjector({
		messages: () => messages, transition: () => {}, clearFinishStatus: () => {}, finishProgress: () => {}, prepareAssistant: () => {},
		activeText: () => "", addMessage: (message) => messages.push(message), markAssistantLatency: () => {}, finalizeOpenPartial: () => {},
		lastActivityReason: () => "ended", runCompleteHook: () => { hooks++ }, capture: () => {}, persist: () => {}, language: () => "en",
		recentToolSummaries: () => [], log: () => {},
	})
	projector.finish("session-1", "completed")
	assert.equal(messages.at(-1).say, "completion_result")
	assert.equal(hooks, 1)
})
