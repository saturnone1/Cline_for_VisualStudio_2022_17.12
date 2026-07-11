"use strict"

const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const sourceRoot = path.resolve(__dirname, "..", "src")
const layerRules = {
	domain: new Set(["application", "infrastructure", "presentation"]),
	application: new Set(["infrastructure", "presentation"]),
	infrastructure: new Set(["presentation"]),
	presentation: new Set(["infrastructure"]),
	features: new Set(["infrastructure", "presentation"]),
}
const violations = []

for (const filePath of walk(sourceRoot)) {
	if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) continue
	const relative = normalize(path.relative(sourceRoot, filePath))
	const sourceLayer = relative.split("/")[0]
	const forbidden = layerRules[sourceLayer]
	if (!forbidden) continue

	const source = fs.readFileSync(filePath, "utf8")
	for (const specifier of importSpecifiers(filePath, source)) {
		if (!specifier.startsWith(".")) {
			if (specifier === "@cline/sdk" && !relative.startsWith("infrastructure/sdk/")) {
				violations.push(`${relative} -> ${specifier} (Cline SDK imports must remain inside the SDK infrastructure adapter)`)
			}
			if (sourceLayer === "domain") {
				violations.push(`${relative} -> ${specifier} (domain must not depend on runtime packages)`)
			}
			if (sourceLayer === "application" && (specifier.startsWith("node:") || specifier === "@cline/sdk")) {
				violations.push(`${relative} -> ${specifier} (application must depend on a port)`)
			}
			if (sourceLayer === "presentation" && specifier.startsWith("node:")) {
				violations.push(`${relative} -> ${specifier} (presentation must use an application port)`)
			}
			continue
		}
		const target = normalize(path.relative(sourceRoot, path.resolve(path.dirname(filePath), specifier)))
		const targetLayer = target.split("/")[0]
		if (forbidden.has(targetLayer)) {
			violations.push(`${relative} -> ${specifier} (${sourceLayer} must not depend on ${targetLayer})`)
		}
	}
}

const routerPath = path.join(sourceRoot, "infrastructure", "webview", "VisualStudioWebviewBackend.ts")
const router = fs.readFileSync(routerPath, "utf8")
for (const marker of ["HostProviderPort", "AgentEnginePort", "WebviewTransportPort", "InteractionLoggerPort"]) {
	if (!router.includes(marker)) violations.push(`VisualStudioWebviewBackend is missing application port: ${marker}`)
}
if (router.includes("VisualStudioHostProvider") || router.includes("sendHostRequest(")) {
	violations.push("VisualStudioWebviewBackend must not reference concrete host or transport implementations.")
}
if (router.includes("runBrowserActionViaDevTools") || router.includes("browserSessions")) {
	violations.push("VisualStudioWebviewBackend must delegate browser execution and session ownership to BrowserHandler.")
}
if (router.includes("parseGitWorktreePorcelain") || router.includes("execFile(\"git\"")) {
	violations.push("VisualStudioWebviewBackend must delegate worktree queries and Git process execution to the worktree feature boundary.")
}
if (router.includes("http.createServer") || router.includes("oauthCallbackSessions")) {
	violations.push("VisualStudioWebviewBackend must delegate OAuth HTTP listening and callback session ownership.")
}
if (router.includes("Token endpoint returned HTTP") || router.includes("Buffer.from(`${exchange.clientId}")) {
	violations.push("VisualStudioWebviewBackend must delegate OAuth token endpoint transport to OAuthTokenHandler.")
}
if (router.includes("SDK provider metadata could not be loaded")) {
	violations.push("VisualStudioWebviewBackend must delegate provider config metadata projection to ProviderCredentialHandler.")
}
if (router.includes('this.logger.log("sidecar", "accountAuthAction"')) {
	violations.push("VisualStudioWebviewBackend must delegate provider auth UI orchestration to ProviderAuthActionHandler.")
}
if (router.includes("oauthCallbackServerListening") || router.includes("oauthCallbackBridgeReady")) {
	violations.push("VisualStudioWebviewBackend must delegate OAuth authorization orchestration to OAuthAuthorizationHandler.")
}
if (router.includes("completeOAuthCallbackSession") || router.includes("oauthTokenExchangeFailed")) {
	violations.push("VisualStudioWebviewBackend must delegate OAuth callback completion to OAuthCallbackHandler.")
}
if (router.includes("readScheduledAgentSpecs") || router.includes("writeScheduledAgentSpec") || router.includes("appendScheduledAgentRun")) {
	violations.push("VisualStudioWebviewBackend must delegate scheduled agent persistence and orchestration to ScheduledAgentHandler.")
}
if (router.includes("getGlobalHooksDirectory") || router.includes("findHookScript") || router.includes("setHookToggle")) {
	violations.push("VisualStudioWebviewBackend must delegate hook discovery and settings persistence to HookSettingsHandler.")
}
if (router.includes("executeHookScript") || router.includes("hookDecisionFromResponse")) {
	violations.push("VisualStudioWebviewBackend must delegate hook execution and decision orchestration to HookExecutionHandler.")
}
if (router.includes("findCheckpointRunCount") || router.includes("resolveCheckpointRestoreScope")) {
	violations.push("VisualStudioWebviewBackend must delegate checkpoint target and restore orchestration to CheckpointHandler.")
}
for (const marker of [".create(message", ".switch(message", ".merge(message", ".recover(message", ".delete(message"]) {
	if (!router.includes(`requireWorktreeMutations()${marker}`)) violations.push(`Worktree mutation route is not delegated through WorktreeMutationHandler: ${marker}`)
}

const controllerPath = path.join(sourceRoot, "presentation", "webview", "VisualStudioWebviewController.ts")
const controller = fs.readFileSync(controllerPath, "utf8")
if (controller.split(/\r?\n/).length > 100) {
	violations.push("VisualStudioWebviewController must remain a thin presentation adapter (100 lines maximum).")
}

const portsRoot = path.join(sourceRoot, "application", "ports")
for (const portPath of walk(portsRoot).filter((filePath) => filePath.endsWith(".ts"))) {
	const relativePort = normalize(path.relative(sourceRoot, portPath))
	const port = fs.readFileSync(portPath, "utf8")
	if (/\bany\b/.test(port)) {
		violations.push(`${relativePort} must use explicit boundary types instead of any.`)
	}
}

const webviewPort = fs.readFileSync(path.join(portsRoot, "WebviewApplicationPort.ts"), "utf8")
if (/handleSdkEvent\(event:\s*unknown\)/.test(webviewPort) || !webviewPort.includes("AgentRuntimeEvent")) {
	violations.push("WebviewApplicationPort must accept the normalized AgentRuntimeEvent contract.")
}
const webviewContract = fs.readFileSync(path.join(sourceRoot, "application", "dto", "WebviewRpc.ts"), "utf8")
for (const marker of ["HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION", "HostSidecarWebviewRequest", "HostSidecarWebviewResponse", "parseHostSidecarWebviewRequest"]) {
	if (!webviewContract.includes(marker)) {
		violations.push(`WebviewRpc contract is missing versioned host-sidecar marker: ${marker}`)
	}
}
if (webviewContract.includes("webviewMessages: unknown[]") || !webviewContract.includes("webviewMessages: JsonValue[]")) {
	violations.push("Host-sidecar WebView responses must expose JSON values rather than unknown payloads.")
}
const webviewController = fs.readFileSync(controllerPath, "utf8")
if (!webviewController.includes("parseHostSidecarWebviewRequest") || !webviewController.includes("createHostSidecarWebviewResponse")) {
	violations.push("VisualStudioWebviewController must enforce the versioned host-sidecar WebView contract.")
}
const productSourceRoot = path.resolve(__dirname, "..", "..")
const repositoryRoot = path.resolve(productSourceRoot, "..")
for (const obsoleteActivePath of [path.join(productSourceRoot, "extension", "Agent"), path.join(productSourceRoot, "extension", "Bridge")]) {
	if (fs.existsSync(obsoleteActivePath)) violations.push(`${normalize(path.relative(repositoryRoot, obsoleteActivePath))} contains an obsolete .NET agent runtime; legacy code must remain outside active source.`)
}
const legacyAgentReadme = path.join(repositoryRoot, "legacy", "dotnet-agent", "README.md")
if (!fs.existsSync(legacyAgentReadme)) violations.push("The excluded legacy .NET agent archive is missing its ownership marker.")
const themeContractSource = fs.readFileSync(path.join(productSourceRoot, "webview", "src", "utils", "ligTheme.ts"), "utf8")
const themeHostSource = fs.readFileSync(path.join(productSourceRoot, "extension", "ToolWindows", "ChatToolWindowControl.xaml.cs"), "utf8")
if (!themeContractSource.includes("LigThemeChangedMessage") || !themeContractSource.includes("protocolVersion: 1")) {
	violations.push("The direct WebView theme bridge must use a typed versioned message.")
}
if (!themeHostSource.includes('message["protocolVersion"]') || !themeHostSource.includes("!= 1")) {
	violations.push("The Visual Studio theme bridge must reject unsupported message versions.")
}
const webviewSourceRoot = path.join(productSourceRoot, "webview", "src")
const grpcClientBase = fs.readFileSync(path.join(webviewSourceRoot, "services", "grpcClientBase.ts"), "utf8")
if (!grpcClientBase.includes("WEBVIEW_RPC_PROTOCOL_VERSION") || !grpcClientBase.includes("protocol_version: WEBVIEW_RPC_PROTOCOL_VERSION")) {
	violations.push("WebView gRPC request envelopes must carry an explicit protocol version.")
}
const streamPublisherSource = fs.readFileSync(path.join(sourceRoot, "infrastructure", "webview", "WebviewStreamPublisher.ts"), "utf8")
if (!router.includes("protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION") || !streamPublisherSource.includes("protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION")) {
	violations.push("All sidecar WebView RPC responses must carry an explicit protocol version.")
}
if (!grpcClientBase.includes("envelope.protocol_version !== WEBVIEW_RPC_PROTOCOL_VERSION")) {
	violations.push("The WebView client must reject unsupported sidecar response versions.")
}
if (!grpcClientBase.includes("parseGrpcResponse(event.data, requestId)") || !grpcClientBase.includes("MessageEvent<unknown>")) {
	violations.push("The WebView client must decode unknown browser messages into a typed RPC response.")
}
if (!webviewContract.includes("unsupported_webview_protocol_version")) {
	violations.push("The sidecar must reject unsupported WebView gRPC protocol versions.")
}
for (const filePath of walk(webviewSourceRoot)) {
	if (!/\.(ts|tsx)$/.test(filePath) || /\.(test|spec|stories)\.(ts|tsx)$/.test(filePath)) continue
	const source = fs.readFileSync(filePath, "utf8")
	const relative = normalize(path.relative(webviewSourceRoot, filePath))
	if (/\bfetch\s*\(/.test(source)) violations.push(`${relative} performs HTTP directly; passive WebView code must use a typed sidecar RPC.`)
	if (/from\s+["']@cline\/sdk(?:[\/"'])/.test(source)) violations.push(`${relative} imports the Cline SDK; SDK access belongs to the sidecar adapter.`)
	if (relative.startsWith("components/settings/providers/") && /\blocalStorage\b/.test(source)) violations.push(`${relative} persists provider state in the WebView; provider persistence belongs to the sidecar.`)
}
const sdkRuntime = fs.readFileSync(path.join(sourceRoot, "infrastructure", "sdk", "ClineSdkRuntime.ts"), "utf8")
if (!sdkRuntime.includes("normalizeAgentRuntimeEvent(event)")) {
	violations.push("ClineSdkRuntime must normalize SDK events before publishing them internally.")
}
if (router.includes("handleAgentEvent(event.event.raw")) {
	violations.push("VisualStudioWebviewBackend must consume the semantic AgentEvent instead of reparsing raw SDK events at ingress.")
}
if (router.includes("const event = semanticEvent.raw")) {
	violations.push("Known semantic AgentEvent variants must project from typed fields; raw payload access is reserved for AgentEventUnknown.")
}
if (router.includes("handleSessionChunk(payload)") || router.includes("handleSessionSnapshot(payload)")) {
	violations.push("Chunk and session snapshot projection must consume normalized AgentRuntimeEvent fields.")
}
for (const legacyCall of ["handleTeamProgress(payload)", "handleHookEvent(payload)", "handlePendingPrompts(payload)", "handlePendingPromptSubmitted(payload)"]) {
	if (router.includes(legacyCall)) violations.push(`Runtime projection must consume normalized fields instead of raw payload: ${legacyCall}`)
}
if (router.includes("handleFileChangedEvent(payload)")) violations.push("Workspace change tracking must consume the normalized WorkspaceChange contract.")
const sdkEventTranslator = fs.readFileSync(path.join(sourceRoot, "infrastructure", "sdk", "ClineSdkEventTranslator.ts"), "utf8")
for (const eventName of ["AgentStarted", "TextDelta", "ReasoningDelta", "ToolCallRequested", "ToolCallCompleted", "ToolCallUpdated", "IterationCompleted", "NoticeReceived", "ToolFinished", "AssistantMessageReceived", "RunFinished", "RunFailed", "UsageUpdated", "AgentDone", "AgentError", "ApprovalRequested", "AgentCompleted", "AgentFailed"]) {
	if (!sdkEventTranslator.includes(`\"${eventName}\"`)) {
		violations.push(`ClineSdkEventTranslator is missing semantic event: ${eventName}`)
	}
}

const mainPath = path.join(sourceRoot, "main.ts")
const main = fs.readFileSync(mainPath, "utf8")
if (main.split(/\r?\n/).length > 100) {
	violations.push("main.ts must remain a composition root (100 lines maximum).")
}
if (main.includes("net.createServer") || main.includes("JSON.parse")) {
	violations.push("main.ts must delegate transport and JSON-RPC concerns to infrastructure.")
}
if (!router.includes("TaskLifecycleUseCase") || !router.includes("StatePersistenceUseCase")) {
	violations.push("VisualStudioWebviewBackend must delegate lifecycle and persistence orchestration to application use cases.")
}
if (router.includes("function connectDevTools") || router.includes("function fetchOpenGraphData")) {
	violations.push("VisualStudioWebviewBackend must delegate browser protocol details to BrowserDevToolsAdapter.")
}
if (router.includes("function sdkMessagesToClineMessages") || router.includes("function buildResumedConversationMessages")) {
	violations.push("VisualStudioWebviewBackend must delegate transcript conversion to ConversationSupport.")
}
if (router.includes("function normalizeApiConfiguration") || router.includes("function createToolPolicies")) {
	violations.push("VisualStudioWebviewBackend must delegate provider policy to ProviderConfiguration.")
}
if (router.includes("function createInitialState") || router.includes("function createPersistedStateSnapshot")) {
	violations.push("VisualStudioWebviewBackend must delegate WebView state assembly to WebviewState.")
}
if (router.includes("function createProviderAuthInfo") || router.includes("function createOAuthAuthorizationRequest")) {
	violations.push("VisualStudioWebviewBackend must delegate provider authentication support to ProviderAuthSupport.")
}

for (const requiredFile of [
	"domain/agent/AgentRuntimeEvent.ts",
	"domain/agent/AgentSessionState.ts",
	"infrastructure/sdk/ClineSdkEventTranslator.ts",
	"application/ports/AgentEnginePort.ts",
	"application/ports/BrowserAutomationPort.ts",
	"application/ports/WorktreeOperationsPort.ts",
	"application/ports/OAuthCallbackListenerPort.ts",
	"application/ports/OAuthAuthorizationPort.ts",
	"application/ports/OAuthTokenExchangePort.ts",
	"application/ports/ProviderCredentialEnvironmentPort.ts",
	"application/ports/ProviderAuthUiPort.ts",
	"application/ports/ScheduledAgentStorePort.ts",
	"application/ports/HookStorePort.ts",
	"application/ports/HookExecutionPort.ts",
	"application/dto/HookContracts.ts",
	"application/dto/OAuthContracts.ts",
	"features/mcp/McpHandler.ts",
	"application/useCases/StatePersistenceUseCase.ts",
	"application/useCases/TaskLifecycleUseCase.ts",
	"application/useCases/TaskSessionUseCase.ts",
	"infrastructure/persistence/JsonStateStore.ts",
	"infrastructure/persistence/LocalScheduledAgentStore.ts",
	"infrastructure/browser/BrowserDevToolsAdapter.ts",
	"infrastructure/conversation/ConversationSupport.ts",
	"infrastructure/conversation/TerminalActivityMonitor.ts",
	"infrastructure/conversation/PartialTextProjector.ts",
	"infrastructure/conversation/FoldedProgressProjector.ts",
	"infrastructure/conversation/AgentTextEventProjector.ts",
	"infrastructure/conversation/AgentToolEventProjector.ts",
	"infrastructure/conversation/AgentLifecycleEventProjector.ts",
	"infrastructure/conversation/AgentAuxiliaryEventProjector.ts",
	"infrastructure/conversation/AgentSnapshotEventProjector.ts",
	"infrastructure/conversation/AgentChunkEventProjector.ts",
	"infrastructure/conversation/TaskCompletionProjector.ts",
	"infrastructure/conversation/ConversationMessageStore.ts",
	"features/taskHistory/TaskHistorySync.ts",
	"features/taskHistory/TaskHistoryCommands.ts",
	"features/taskHistory/TaskTranscriptHydrator.ts",
	"features/chat/TaskRpcHandler.ts",
	"features/chat/clearTask/ClearTaskHandler.ts",
	"features/chat/cancelTask/CancelTaskFlow.ts",
	"features/chat/runtime/AgentRunRecoveryFlow.ts",
	"features/chat/runtime/AgentRunCompletionFlow.ts",
	"features/chat/runtime/SendOrResumeSessionFlow.ts",
	"features/chat/runtime/ResumeSessionFlow.ts",
	"features/chat/runtime/LaunchAgentSessionFlow.ts",
	"features/chat/startTask/PrepareNewTaskFlow.ts",
	"features/chat/startTask/StartNewTaskFlow.ts",
	"features/chat/sendMessage/AskResponseInteractionFlow.ts",
	"features/chat/sendMessage/SendUserMessageFlow.ts",
	"features/chat/runtime/CompactSessionFlow.ts",
	"infrastructure/configuration/ProviderConfiguration.ts",
	"infrastructure/configuration/ApiConfigurationProfileManager.ts",
	"infrastructure/configuration/SettingsMutationHandler.ts",
	"infrastructure/configuration/AgentSdkConfigBuilder.ts",
	"infrastructure/models/EffectiveModelResolver.ts",
	"infrastructure/auth/ProviderAuthSupport.ts",
	"infrastructure/auth/NodeOAuthCallbackListener.ts",
	"infrastructure/auth/FetchOAuthTokenExchangeAdapter.ts",
	"infrastructure/auth/ProviderCredentialEnvironmentAdapter.ts",
	"infrastructure/auth/VisualStudioProviderAuthUiAdapter.ts",
	"infrastructure/auth/ProviderOAuthAuthorizationAdapter.ts",
	"infrastructure/hooks/HookRuntime.ts",
	"infrastructure/hooks/LocalHookStore.ts",
	"infrastructure/hooks/ProcessHookExecutionAdapter.ts",
	"infrastructure/models/ModelCatalog.ts",
	"infrastructure/models/ProviderModelCatalogHandler.ts",
	"infrastructure/persistence/LocalAutomationStore.ts",
	"infrastructure/worktree/WorktreeSupport.ts",
	"infrastructure/worktree/NodeWorktreeOperationsAdapter.ts",
	"infrastructure/workspace/ChangeTrackingHandler.ts",
	"infrastructure/webview/WebviewState.ts",
	"infrastructure/webview/WebviewStreamPublisher.ts",
	"infrastructure/webview/SettingsRpcDecoder.ts",
	"infrastructure/webview/AccountRpcDecoder.ts",
	"infrastructure/webview/BrowserRpcDecoder.ts",
	"infrastructure/webview/TerminalRpcDecoder.ts",
	"infrastructure/webview/TaskRpcDecoder.ts",
	"infrastructure/webview/CheckpointRpcDecoder.ts",
	"infrastructure/transport/SidecarRpcServer.ts",
	"bootstrap/SidecarConnectionFactory.ts",
	"features/chat/sendMessage/SendMessageCommand.ts",
	"features/chat/sendMessage/SendMessageHandler.ts",
	"features/chat/startTask/StartTaskCommand.ts",
	"features/chat/startTask/StartTaskHandler.ts",
	"features/chat/cancelTask/CancelTaskCommand.ts",
	"features/chat/cancelTask/CancelTaskHandler.ts",
	"features/approvals/ApprovalCoordinator.ts",
	"features/taskHistory/TaskHistoryCollection.ts",
	"features/taskHistory/TaskSnapshotStore.ts",
	"features/providers/ProviderSelection.ts",
	"features/providers/OAuthCallbackCoordinator.ts",
	"features/providers/OAuthCallbackHandler.ts",
	"features/providers/OAuthAuthorizationHandler.ts",
	"features/providers/OAuthTokenHandler.ts",
	"features/providers/ProviderCredentialPolicy.ts",
	"features/providers/ProviderCredentialHandler.ts",
	"features/providers/ProviderAuthActionPolicy.ts",
	"features/providers/ProviderAuthActionHandler.ts",
	"features/providers/AccountRpcHandler.ts",
	"features/settings/PlanActMode.ts",
	"features/settings/SdkSettingsHandler.ts",
	"features/settings/SettingsRpcHandler.ts",
	"features/worktrees/WorktreePolicy.ts",
	"features/worktrees/WorktreeQueryHandler.ts",
	"features/worktrees/WorktreeMutationHandler.ts",
	"features/browser/BrowserPolicy.ts",
	"features/browser/BrowserHandler.ts",
	"features/browser/BrowserRpcHandler.ts",
	"features/terminal/TerminalRpcHandler.ts",
	"features/hooks/HookPolicy.ts",
	"features/hooks/HookSettingsHandler.ts",
	"features/hooks/HookExecutionHandler.ts",
	"features/hooks/HookLifecycleCoordinator.ts",
	"features/scheduledAgents/ScheduledAgentPolicy.ts",
	"features/scheduledAgents/ScheduledAgentHandler.ts",
	"features/checkpoints/CheckpointPolicy.ts",
	"features/checkpoints/CheckpointHandler.ts",
	"features/checkpoints/CheckpointRpcHandler.ts",
	"features/conversation/ConversationProjectionState.ts",
	"features/runtime/TaskActivityMonitor.ts",
	"features/runtime/PartialStateScheduler.ts",
	"features/runtime/SendLatencyMonitor.ts",
]) {
	if (!fs.existsSync(path.join(sourceRoot, ...requiredFile.split("/")))) {
		violations.push(`Missing architecture component: ${requiredFile}`)
	}
}

if (violations.length) {
	console.error("Clean Architecture dependency check failed:")
	for (const violation of violations) console.error(`- ${violation}`)
	process.exit(1)
}

console.log("Clean Architecture dependency check passed.")

function walk(directory) {
	const files = []
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name)
		if (entry.isDirectory()) files.push(...walk(fullPath))
		else files.push(fullPath)
	}
	return files
}

function importSpecifiers(filePath, source) {
	const values = []
	const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
	visit(sourceFile)
	return values

	function visit(node) {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			values.push(node.moduleSpecifier.text)
		}
		if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
				values.push(node.arguments[0].text)
			}
		}
		ts.forEachChild(node, visit)
	}
}

function normalize(value) {
	return value.replace(/\\/g, "/")
}
