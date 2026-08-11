"use strict"

const fs = require("node:fs")
const path = require("node:path")

const sidecarRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(sidecarRoot, "src")
const repoRoot = path.resolve(sidecarRoot, "..", "..")
const sources = readTree(sourceRoot)
const webviewSources = readTree(path.join(repoRoot, "src", "webview", "src"), (file) => !/\.(?:test|spec|stories)\.(?:ts|tsx)$/.test(file))

const requiredCapabilities = [
	["progress phase splitting", "type ProgressPhase"],
	["progress phase transitions", "beginProgressPhase"],
	["browser DevTools session registry", "private readonly sessions"],
	["browser action execution phases", "this.automation.runAction"],
	["OAuth refresh state RPC", "AccountService.refreshOAuthCredential"],
	["checkpoint compare RPC", "CheckpointsService.checkpointDiff"],
	["worktree merge recovery", "async recover(request: RecoverWorktreeRequest)"],
	["provider catalog diagnostics", "createCatalogDiagnostics"],
	["send latency diagnostics", "sendLatency.firstSdkEvent"],
	["targeted Plan/Act toggle", "resolveRequestedPlanActMode"],
	["strict Plan-mode tool policy", "isStrictPlanModeBlockedTool"],
	["completion payload fallback", "extractCompletionTextFromResult"],
	["restored transcript transport", "buildResumedConversationMessages"],
	["persisted task snapshots", "taskSnapshots: state.taskSnapshots"],
	["MCP mutation stream updates", "buildMcpServerStreamMessages"],
	["API profile replacement", "activate(profileId: string)"],
	["runtime event normalization", "normalizeAgentRuntimeEvent(event)"],
	["typed WebView RPC protocol", "HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION"],
]

for (const [label, marker] of requiredCapabilities) requireText(label, sources, marker)

const sdkRuntime = read("infrastructure/sdk/ClineSdkRuntime.ts")
const sdkMcpAdapter = read("infrastructure/sdk/ClineSdkMcpAdapter.ts")
const sdkMcpSettingsStore = read("infrastructure/sdk/ClineSdkMcpSettingsStore.ts")
const sdkSessionAdapter = read("infrastructure/sdk/ClineSdkSessionAdapter.ts")
const sdkSessionRequestBuilder = read("infrastructure/sdk/SdkSessionRequestBuilder.ts")
const configBuilder = read("infrastructure/configuration/AgentSdkConfigBuilder.ts")
const connectionFactory = read("bootstrap/SidecarConnectionFactory.ts")
const server = read("infrastructure/transport/SidecarRpcServer.ts")
const streamPublisher = read("infrastructure/webview/WebviewStreamPublisher.ts")
const router = read("infrastructure/webview/VisualStudioWebviewBackend.ts")
const unaryRouter = read("infrastructure/webview/WebviewUnaryRpcRouter.ts")
const runtimeEnvironment = read("infrastructure/configuration/RuntimeEnvironment.ts")

requireMatch("long API timeout policy", runtimeEnvironment, /apiRequestTimeoutMs:\s*1_800_000/)
requireMatch("API timeout uses runtime policy", configBuilder, /readPositiveIntEnv\("VSCLINE_API_TIMEOUT_MS", RUNTIME_DEFAULTS\.apiRequestTimeoutMs\)/)
requireMatch("long idle watchdog", connectionFactory, /readPositiveIntEnv\("VSCLINE_TASK_IDLE_COMPLETE_MS", 600_000\)/)
requireMatch("SDK prompt remains unchanged", sdkSessionAdapter, /return await core\.send\(\{[\s\S]{0,180}prompt: request\.prompt/)
requireMatch("MCP tools are passed into SDK session translation", sdkSessionAdapter, /buildSdkStartInput\(request, workspaceRoots, await this\.dependencies\.createExtraTools\(\)\)/)
requireText("MCP tools are attached to SDK start configuration", sdkSessionRequestBuilder, "extraTools,")
requireMatch("MCP extra-tool injection failures remain visible", sdkMcpAdapter, /createExtraToolsForSession\(\)[\s\S]{0,300}return this\.createMcpExtraTools\(\)/)
requireText("MCP per-server session tool failures are retained", sdkMcpAdapter, "this.sessionToolErrors.set(")
requireMatch("MCP writes are serialized", sdkMcpSettingsStore, /mutationQueue[\s\S]*this\.mutationQueue\.then/)
requireMatch("MCP writes are atomic", sdkMcpSettingsStore, /writeFileAtomic\(`\$\{filePath\}\.bak`[\s\S]*writeFileAtomic\(filePath/)
requireText("connection composition root", connectionFactory, "new VisualStudioWebviewBackend(")
requireText("passive WebView controller", connectionFactory, "new VisualStudioWebviewController(backend)")
requireSequence("sidecar shutdown flush", server, ["scope.webview.dispose()", "scope.runtime.dispose()", "await this.flushLogs()"])
requireSequence("stream cancellation cleanup", streamPublisher, ["unsubscribe(requestId: string)", "this.stateRequests.delete(requestId)", "this.partialRequests.delete(requestId)", "this.stateDeliveryKeys.delete(requestId)", "this.partialDeliveryKeys.delete(requestId)"])
requireMatch("MCP mutations refresh runtime settings", unaryRouter, /result\.publishToStreams[\s\S]{0,160}mcpStreamMessages/)

if (sdkRuntime.includes("<lig-vs-mcp-context>")) fail("MCP status must not be injected into SDK prompts.")
if (/\bfetch\s*\(/.test(webviewSources)) fail("The passive WebView must not perform direct HTTP requests.")
if (/from\s+["']@cline\/sdk/.test(webviewSources)) fail("The WebView must not import the Cline SDK.")

console.log(`VS2022 functional parity smoke passed (${requiredCapabilities.length} capabilities and behavioral guards).`)

function read(relativePath) { return fs.readFileSync(path.join(sourceRoot, ...relativePath.split("/")), "utf8") }
function readTree(root, include = () => true) {
	return walk(root).filter((file) => /\.(?:ts|tsx|js)$/.test(file) && include(file)).map((file) => fs.readFileSync(file, "utf8")).join("\n")
}
function walk(root) {
	if (!fs.existsSync(root)) return []
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(root, entry.name)
		return entry.isDirectory() ? walk(fullPath) : [fullPath]
	})
}
function requireText(label, source, marker) { if (!source.includes(marker)) fail(`${label} is missing marker: ${marker}`) }
function requireMatch(label, source, pattern) { if (!pattern.test(source)) fail(`${label} did not match ${pattern}`) }
function requireSequence(label, source, markers) {
	let cursor = -1
	for (const marker of markers) {
		cursor = source.indexOf(marker, cursor + 1)
		if (cursor < 0) fail(`${label} is missing ordered marker: ${marker}`)
	}
}
function fail(message) { console.error(`VS2022 functional parity smoke failed. ${message}`); process.exit(1) }
