const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { validateGrpcRequestContract } = require("../dist/application/dto/WebviewRpc")
const { WEBVIEW_RPC_SIDECAR_ROUTES, validateWebviewRpcPayload, webviewRpcOperation } = require("../dist/application/dto/generated/WebviewRpcContract")
const decoderDefinitions = [
	["settings", "SettingsRpcDecoder", "decodeSettingsRpcCommand"],
	["account", "AccountRpcDecoder", "decodeAccountRpcCommand"],
	["browser", "BrowserRpcDecoder", "decodeBrowserRpcCommand"],
	["terminal", "TerminalRpcDecoder", "decodeTerminalRpcCommand"],
	["task", "TaskRpcDecoder", "decodeTaskRpcCommand"],
	["checkpoint", "CheckpointRpcDecoder", "decodeCheckpointRpcCommand"],
	["hook", "HookRpcDecoder", "decodeHookRpcCommand"],
	["scheduledAgent", "ScheduledAgentRpcDecoder", "decodeScheduledAgentRpcCommand"],
	["worktree", "WorktreeRpcDecoder", "decodeWorktreeRpcCommand"],
	["mcp", "McpRpcDecoder", "decodeMcpRpcCommand"],
	["modelCatalog", "ModelCatalogRpcDecoder", "decodeModelCatalogRpcCommand"],
	["file", "FileRpcDecoder", "decodeFileRpcCommand"],
	["instructionSettings", "InstructionSettingsRpcDecoder", "decodeInstructionSettingsRpcCommand"],
	["uiWeb", "UiWebRpcDecoder", "decodeUiWebRpcCommand"],
	["plugin", "PluginRpcDecoder", "decodePluginRpcCommand"],
].map(([route, file, name]) => [route, require(`../dist/infrastructure/webview/${file}`)[name]])
const { decodeStreamingRpcCommand } = require("../dist/infrastructure/webview/StreamingRpcDecoder")

const repoRoot = path.resolve(__dirname, "../../..")
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/webview-rpc.json"), "utf8"))
const fixtures = JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/generated/webview-rpc-fixtures.json"), "utf8"))

test("generated RPC fixtures cover every canonical operation", () => {
	assert.equal(fixtures.length, manifest.operations.length)
	assert.deepEqual(fixtures.map((fixture) => fixture.operation), manifest.operations.map((operation) => `${operation.service}.${operation.method}`))
	for (const [index, fixture] of fixtures.entries()) {
		const operation = manifest.operations[index]
		assert.deepEqual(validateWebviewRpcPayload(operation.service, operation.method, "request", fixture.request), { ok: true }, `${fixture.operation} request`)
		assert.deepEqual(validateWebviewRpcPayload(operation.service, operation.method, "response", fixture.response), { ok: true }, `${fixture.operation} response`)
	}
})

test("every canonical RPC operation has request and response payload shapes", () => {
	for (const operation of manifest.operations) {
		assert.ok(operation.requestShape, `${operation.service}.${operation.method} requestShape`)
		assert.ok(operation.responseShape, `${operation.service}.${operation.method} responseShape`)
		assert.ok(manifest.shapes[operation.requestShape], operation.requestShape)
		assert.ok(manifest.shapes[operation.responseShape], operation.responseShape)
	}
})

test("generated sidecar route registry matches the canonical manifest", () => {
	const expected = [...new Set(manifest.operations.filter((operation) => operation.sidecar).map((operation) => operation.route))]
	assert.deepEqual(WEBVIEW_RPC_SIDECAR_ROUTES, expected)
})

test("generated sidecar routes resolve to exactly one matching decoder", () => {
	for (const operation of manifest.operations) {
		const key = `${operation.service}.${operation.method}`
		const generated = webviewRpcOperation(operation.service, operation.method)
		if (!operation.sidecar) {
			assert.equal(generated.route, undefined, key)
			continue
		}
		const routes = decoderDefinitions.filter(([, decode]) => decode(key, {}) !== undefined).map(([route]) => route)
		if (decodeStreamingRpcCommand(key) !== undefined) routes.push("stream")
		assert.deepEqual(routes, [generated.route], key)
	}
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

test("expanded payload shapes reject object-array and required-response drift", () => {
	assert.deepEqual(validateWebviewRpcPayload("FileService", "revertVsClineChanges", "request", { files: ["not-an-object"] }), {
		ok: false,
		reason: "invalid_field_type",
		field: "files",
	})
	assert.deepEqual(validateWebviewRpcPayload("FileService", "searchCommits", "response", { results: [] }), {
		ok: false,
		reason: "missing_required_field",
		field: "commits",
	})
	assert.deepEqual(validateWebviewRpcPayload("McpService", "toggleToolAutoApprove", "request", {
		serverName: "server",
		toolNames: ["one", 2],
		autoApprove: true,
	}), {
		ok: false,
		reason: "invalid_field_type",
		field: "toolNames",
	})
})

test("nested payload shapes and enums reject history contract drift", () => {
	assert.deepEqual(validateWebviewRpcPayload("TaskService", "getTaskHistory", "request", { sortBy: "expensive" }), {
		ok: false, reason: "invalid_field_type", field: "sortBy",
	})
	assert.deepEqual(validateWebviewRpcPayload("TaskService", "getTaskHistory", "response", { tasks: [{ id: "1", ts: "now", task: "review" }] }), {
		ok: false, reason: "invalid_field_type", field: "tasks[0].ts",
	})
})

test("nested MCP and browser payload shapes reject malformed list items", () => {
	assert.deepEqual(validateWebviewRpcPayload("McpService", "getLatestMcpServers", "response", { mcpServers: [{ name: "server" }] }), {
		ok: false, reason: "missing_required_field", field: "mcpServers[0].config",
	})
	assert.deepEqual(validateWebviewRpcPayload("BrowserService", "listBrowserTabs", "response", { tabs: [{ id: "tab" }] }), {
		ok: false, reason: "missing_required_field", field: "tabs[0].type",
	})
})
