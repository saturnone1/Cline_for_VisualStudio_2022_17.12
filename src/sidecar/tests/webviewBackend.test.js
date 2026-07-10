const assert = require("node:assert/strict")
const test = require("node:test")
const { StatePersistenceUseCase } = require("../dist/application/useCases/StatePersistenceUseCase")
const { TaskLifecycleUseCase } = require("../dist/application/useCases/TaskLifecycleUseCase")
const { VisualStudioWebviewBackend } = require("../dist/infrastructure/webview/VisualStudioWebviewBackend")

function createBackend() {
	const openedUrls = []
	const saved = []
	const host = {
		workspaceClient: { getWorkspacePaths: async () => [] },
		envClient: {
			openExternal: async (request) => { openedUrls.push(request.value); return {} },
		},
		windowClient: {},
		diffClient: {},
		extensionFsPath: "C:\\extension",
		globalStorageFsPath: "C:\\storage",
	}
	const transport = { sendWebviewMessage: async () => undefined }
	const logger = { log() {} }
	const store = { load: () => null, save: (snapshot) => saved.push(snapshot), clear() {} }
	const persistence = new StatePersistenceUseCase(store, 10)
	const backend = new VisualStudioWebviewBackend(host, transport, logger, persistence, new TaskLifecycleUseCase())
	return { backend, openedUrls, saved }
}

function grpcRequest(service, method, requestId, message = {}, streaming = false) {
	return {
		type: "grpc_request",
		grpc_request: { service, method, request_id: requestId, message, is_streaming: streaming },
	}
}

test("webview backend forwards external URLs and returns the matching gRPC response", async () => {
	const { backend, openedUrls } = createBackend()
	const result = await backend.handle(grpcRequest("UiService", "openUrl", "url-1", { value: "https://example.com" }))

	assert.deepEqual(openedUrls, ["https://example.com"])
	assert.equal(result.handled, true)
	assert.equal(result.webviewMessages[0].grpc_response.request_id, "url-1")
	backend.dispose()
})

test("webview backend registers and cancels state streams without stale responses", async () => {
	const { backend } = createBackend()
	const subscribed = await backend.handle(grpcRequest("StateService", "subscribeToState", "state-1", {}, true))
	assert.equal(subscribed.webviewMessages[0].grpc_response.is_streaming, true)

	const cancelled = await backend.handle({ type: "grpc_request_cancel", grpc_request_cancel: { request_id: "state-1" } })
	assert.equal(cancelled.handled, true)
	assert.deepEqual(cancelled.webviewMessages, [])
	backend.dispose()
})

test("webview backend flushes the latest state exactly once when disposed", () => {
	const { backend, saved } = createBackend()
	backend.dispose()
	assert.equal(saved.length, 1)
	assert.equal(saved[0].mode, "act")
})
