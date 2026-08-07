const assert = require("node:assert/strict")
const test = require("node:test")
const { classifyRuntimeError, createRuntimeErrorRecoveryPolicy } = require("../dist/application/services/RuntimeErrorRecoveryPolicy")
const { AgentRunRecoveryFlow } = require("../dist/features/chat/runtime/AgentRunRecoveryFlow")

// The failure the user actually hit: an OpenAI-compatible endpoint answered with
// a body the SDK schema rejects, which says nothing about the task itself.
const PROVIDER_SCHEMA_ERROR = new Error(
	'Type validation failed: Value: {"error":"Unexpected error: "}. Error message: [ { "code": "invalid_union" } ]',
)

test("a malformed provider response is transient while configuration faults are not", () => {
	assert.equal(classifyRuntimeError(PROVIDER_SCHEMA_ERROR), "transient")
	assert.equal(classifyRuntimeError(new Error("fetch failed")), "transient")
	assert.equal(classifyRuntimeError(new Error("Request failed with status 503")), "transient")

	assert.equal(classifyRuntimeError(new Error("401 Unauthorized: invalid api key")), "fatal")
	assert.equal(classifyRuntimeError(new Error("prompt is too long for the context window")), "fatal")
	assert.equal(classifyRuntimeError(new Error("The operation was aborted")), "fatal")
	// An unrecognised failure keeps the historical behaviour of reaching the user.
	assert.equal(classifyRuntimeError(new Error("something entirely new")), "fatal")
})

test("the recovery policy retries a transient failure up to its budget and then surfaces it", () => {
	const policy = createRuntimeErrorRecoveryPolicy({ maxAttempts: () => 2, log: () => undefined })

	const first = policy.decide("session-1", PROVIDER_SCHEMA_ERROR)
	assert.equal(first.action, "retry")
	assert.equal(first.attempt, 1)
	assert.match(first.guidance, /provider or transport failure/i)
	assert.match(first.guidance, /Unexpected error/)

	assert.equal(policy.decide("session-1", PROVIDER_SCHEMA_ERROR).attempt, 2)

	const exhausted = policy.decide("session-1", PROVIDER_SCHEMA_ERROR)
	assert.equal(exhausted.action, "surface")
	assert.equal(exhausted.reason, "attempts-exhausted")
})

test("the retry budget is per session and resets once a run comes back", () => {
	const policy = createRuntimeErrorRecoveryPolicy({ maxAttempts: () => 1, log: () => undefined })

	assert.equal(policy.decide("session-1", PROVIDER_SCHEMA_ERROR).action, "retry")
	assert.equal(policy.decide("session-1", PROVIDER_SCHEMA_ERROR).action, "surface")
	// A different session must not inherit an exhausted budget.
	assert.equal(policy.decide("session-2", PROVIDER_SCHEMA_ERROR).action, "retry")

	policy.noteRunSucceeded("session-1")
	assert.equal(policy.decide("session-1", PROVIDER_SCHEMA_ERROR).action, "retry")
})

test("a fatal failure is never retried", () => {
	const policy = createRuntimeErrorRecoveryPolicy({ maxAttempts: () => 5, log: () => undefined })
	const decision = policy.decide("session-1", new Error("401 Unauthorized"))
	assert.equal(decision.action, "surface")
	assert.equal(decision.reason, "fatal")
})

test("retries are disabled when the configured budget is zero", () => {
	const policy = createRuntimeErrorRecoveryPolicy({ maxAttempts: () => 0, log: () => undefined })
	const decision = policy.decide("session-1", PROVIDER_SCHEMA_ERROR)
	assert.equal(decision.action, "surface")
	assert.equal(decision.reason, "disabled")
})

function buildRecoveryFlow(overrides) {
	const calls = { failures: 0, retries: 0, broadcasts: 0, guidance: "" }
	const flow = new AgentRunRecoveryFlow({
		currentGeneration: () => 1,
		isTerminal: () => false,
		isStopping: () => false,
		activeText: () => "",
		hasAssistantText: () => false,
		hydrate: async () => false,
		sessionStatus: async () => "failed",
		finishTask: () => undefined,
		updateTask: () => undefined,
		broadcast: async () => { calls.broadcasts++ },
		decideRecovery: () => ({ action: "retry", attempt: 1, maxAttempts: 2, guidance: "keep going" }),
		retry: async (_sessionId, decision) => { calls.retries++; calls.guidance = decision.guidance; return true },
		projectFailure: () => { calls.failures++ },
		log: () => undefined,
		...overrides,
	})
	return { flow, calls }
}

test("a transient run failure reaches the agent instead of ending the task", async () => {
	const { flow, calls } = buildRecoveryFlow()

	await flow.recover("session-1", "send", 1, PROVIDER_SCHEMA_ERROR)

	assert.equal(calls.retries, 1)
	assert.equal(calls.guidance, "keep going")
	// The whole point: the task must not be terminated behind the agent's back.
	assert.equal(calls.failures, 0)
})

test("a retry that cannot be dispatched still surfaces the original failure", async () => {
	const { flow, calls } = buildRecoveryFlow({ retry: async () => { throw new Error("engine unavailable") } })

	await flow.recover("session-1", "send", 1, PROVIDER_SCHEMA_ERROR)

	assert.equal(calls.failures, 1)
})

test("a cancelled run is never restarted by the retry path", async () => {
	// Aborting the stream looks exactly like a transient transport fault, and the
	// cancel flow only advances the run generation after cancellation settles, so
	// the lifecycle state is the only thing that can tell the two apart.
	const { flow, calls } = buildRecoveryFlow({ isStopping: () => true })

	await flow.recover("session-1", "send", 1, new Error("socket hang up"))

	assert.equal(calls.retries, 0)
	assert.equal(calls.failures, 1)
})

test("an abort error is classified fatal even outside the stopping window", () => {
	const abort = new Error("Operation was cancelled.")
	abort.name = "AbortError"
	assert.equal(classifyRuntimeError(abort), "fatal")
})

test("a refused retry surfaces the failure exactly once", async () => {
	const { flow, calls } = buildRecoveryFlow({ retry: async () => false })

	await flow.recover("session-1", "send", 1, PROVIDER_SCHEMA_ERROR)

	assert.equal(calls.failures, 1)
})
