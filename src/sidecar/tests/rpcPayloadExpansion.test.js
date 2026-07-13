const assert = require("node:assert/strict")
const test = require("node:test")
const { FileRpcHandler } = require("../dist/features/files/FileRpcHandler")
const { AccountRpcHandler } = require("../dist/features/providers/AccountRpcHandler")
const { checkIsImageUrl } = require("../dist/infrastructure/browser/BrowserDevToolsAdapter")
const { validateWebviewRpcPayload } = require("../dist/application/dto/generated/WebviewRpcContract")
const { ProviderModelCatalogHandler } = require("../dist/infrastructure/models/ProviderModelCatalogHandler")
const { decodeModelCatalogRpcCommand } = require("../dist/infrastructure/webview/ModelCatalogRpcDecoder")
const { decodeFileRpcCommand } = require("../dist/infrastructure/webview/FileRpcDecoder")
const { decodeSettingsRpcCommand } = require("../dist/infrastructure/webview/SettingsRpcDecoder")

test("file search commands preserve their distinct response contracts", async () => {
	const handler = new FileRpcHandler({})
	const files = decodeFileRpcCommand("FileService.searchFiles", { value: "src" })
	const commits = decodeFileRpcCommand("FileService.searchCommits", { value: "fix" })

	assert.deepEqual(await handler.handle(files), { payload: { results: [], values: [] } })
	assert.deepEqual(await handler.handle(commits), { payload: { commits: [], values: [] } })
})

test("terminal timeout decoder accepts the WebView timeoutMs field", () => {
	assert.deepEqual(
		decodeSettingsRpcCommand("StateService.updateTerminalConnectionTimeout", { timeoutMs: 4500 }),
		{ type: "setTerminalTimeout", timeout: 4500 },
	)
})

test("account credits match the WebView transaction and balance contract", async () => {
	const result = await new AccountRpcHandler({}).handle({ type: "credits" })
	assert.deepEqual(result.payload, {
		credits: 0,
		balance: { currentBalance: 0 },
		value: 0,
		usageTransactions: [],
		paymentTransactions: [],
	})
	assert.deepEqual(validateWebviewRpcPayload("AccountService", "getUserCredits", "response", result.payload), { ok: true })
})

test("image URL probe preserves both canonical and compatibility boolean fields", async () => {
	const result = await checkIsImageUrl("not a URL")
	assert.deepEqual(result, { isImage: false, value: false, success: false })
	assert.deepEqual(validateWebviewRpcPayload("WebService", "checkIsImageUrl", "response", result), { ok: true })
})

test("legacy model catalog RPCs preserve the payloads consumed by their UI views", () => {
	const catalogs = new ProviderModelCatalogHandler(() => undefined)
	const cases = [
		["ModelsService.getVsCodeLmModels", { models: [], supported: false, message: "VS Code language models are not available in the Visual Studio host." }],
		["ModelsService.getSapAiCoreModels", { deployments: [], orchestrationAvailable: false, supported: false, message: "SAP AI Core discovery is not implemented in the Visual Studio host." }],
		["ModelsService.refreshClineRecommendedModelsRpc", { recommended: [], free: [], supported: false, message: "Online Cline recommendations are unavailable in air-gap Visual Studio mode." }],
	]
	for (const [operation, payload] of cases) {
		const [service, method] = operation.split(".")
		assert.deepEqual(catalogs.unsupported(operation), payload)
		assert.deepEqual(validateWebviewRpcPayload(service, method, "response", payload), { ok: true })
	}
	assert.deepEqual(decodeModelCatalogRpcCommand("ModelsService.getLmStudioModels", { value: "http://localhost:1234" }), {
		type: "lmStudioValues",
		baseUrl: "http://localhost:1234",
	})
})
