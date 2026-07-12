const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { validateGrpcRequestContract } = require("../dist/application/dto/WebviewRpc")
const { validateWebviewRpcPayload } = require("../dist/application/dto/generated/WebviewRpcContract")

const repoRoot = path.resolve(__dirname, "../../..")
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/webview-rpc.json"), "utf8"))
const fixtures = JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/generated/webview-rpc-fixtures.json"), "utf8"))

test("generated RPC fixtures cover every canonical operation", () => {
	assert.equal(fixtures.length, manifest.operations.length)
	assert.deepEqual(fixtures.map((fixture) => fixture.operation), manifest.operations.map((operation) => `${operation.service}.${operation.method}`))
})

test("sidecar contract validates operation ownership and invocation kind", () => {
	for (const [index, operation] of manifest.operations.entries()) {
		const wire = fixtures[index].envelope.grpc_request
		const result = validateGrpcRequestContract({
			service: wire.service,
			method: wire.method,
			requestId: wire.request_id,
			isStreaming: wire.is_streaming,
			message: wire.message,
		})
		assert.deepEqual(result, operation.sidecar ? { ok: true } : { ok: false, reason: "unsupported_sidecar_operation" }, fixtures[index].operation)
	}
})

test("sidecar contract rejects unknown and invocation-kind drift", () => {
	assert.deepEqual(validateGrpcRequestContract({ service: "MissingService", method: "missing", requestId: "1", isStreaming: false, message: {} }), {
		ok: false,
		reason: "unknown_rpc_operation",
	})
	assert.deepEqual(validateGrpcRequestContract({ service: "StateService", method: "subscribeToState", requestId: "2", isStreaming: false, message: {} }), {
		ok: false,
		reason: "rpc_kind_mismatch",
	})
})

test("generated payload shapes reject Task RPC field drift on both wire directions", () => {
	assert.deepEqual(
		validateGrpcRequestContract({
			service: "TaskService",
			method: "newTask",
			requestId: "task-1",
			isStreaming: false,
			message: { text: "start", images: [42] },
		}),
		{ ok: false, reason: "invalid_rpc_payload" },
	)
	assert.deepEqual(validateWebviewRpcPayload("TaskService", "toggleTaskFavorite", "request", { taskId: "1" }), {
		ok: false,
		reason: "missing_required_field",
		field: "isFavorited",
	})
	assert.deepEqual(validateWebviewRpcPayload("TaskService", "getTotalTasksSize", "response", { value: "1" }), {
		ok: false,
		reason: "invalid_field_type",
		field: "value",
	})
})
