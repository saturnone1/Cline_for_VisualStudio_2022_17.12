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

const sourceFiles = walk(sourceRoot).filter((filePath) => /\.(ts|tsx)$/.test(filePath) && !filePath.endsWith(".d.ts"))
const importGraph = new Map(sourceFiles.map((filePath) => [filePath, new Set()]))
for (const filePath of sourceFiles) {
	const source = fs.readFileSync(filePath, "utf8")
	for (const specifier of importSpecifiers(filePath, source)) {
		if (!specifier.startsWith(".")) continue
		const target = resolveTypeScriptModule(filePath, specifier)
		if (target && importGraph.has(target)) importGraph.get(filePath).add(target)
	}
}
for (const component of stronglyConnectedComponents(importGraph).filter((items) => items.length > 1)) {
	const members = component.map((filePath) => normalize(path.relative(sourceRoot, filePath))).sort()
	violations.push(`Circular TypeScript dependency: ${members.join(" -> ")}`)
}

const featuresRoot = path.join(sourceRoot, "features")
for (const entry of fs.readdirSync(featuresRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
	const readmePath = path.join(featuresRoot, entry.name, "README.md")
	if (!fs.existsSync(readmePath)) {
		violations.push(`features/${entry.name}/README.md is required for AI-maintainable slice ownership.`)
		continue
	}
	const readme = fs.readFileSync(readmePath, "utf8")
	for (const marker of ["Inputs:", "Outputs:", "Owned state:", "Tests:"]) {
		if (!readme.includes(marker)) violations.push(`features/${entry.name}/README.md is missing ${marker}`)
	}
}

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

const facadePath = path.join(sourceRoot, "infrastructure", "webview", "VisualStudioWebviewBackend.ts")
const facade = fs.readFileSync(facadePath, "utf8")
if (facade.split(/\r?\n/).length > 200 || !facade.includes("WebviewBackendComposition")) {
	violations.push("VisualStudioWebviewBackend must remain a thin composition/dispatch facade (200 lines maximum).")
}

const maintenanceRepositoryRoot = path.resolve(sourceRoot, "..", "..", "..")
for (const ownershipDocument of ["src/webview/README.md", "src/extension/README.md", "src/shared/README.md"]) {
	const documentPath = path.join(maintenanceRepositoryRoot, ownershipDocument)
	if (!fs.existsSync(documentPath)) {
		violations.push(`${ownershipDocument} is required for cross-runtime AI ownership guidance.`)
		continue
	}
	const document = fs.readFileSync(documentPath, "utf8")
	for (const marker of ["Inputs:", "Outputs:", "Owned state:", "Feature owners:", "Tests:"]) {
		if (!document.includes(marker)) violations.push(`${ownershipDocument} is missing ${marker}`)
	}
}
const documentationIndex = fs.readFileSync(path.join(maintenanceRepositoryRoot, "docs", "README.md"), "utf8")
if (!documentationIndex.includes("AiMaintenanceGuide.md")) {
	violations.push("docs/README.md must point AI maintainers to AiMaintenanceGuide.md.")
}
if (facade.includes("createInitialState(") || facade.includes("new WebviewUnaryRpcRouter") || facade.includes("new AgentRuntimeEventDispatcher")) {
	violations.push("VisualStudioWebviewBackend must not rebuild state, RPC routing, or runtime event composition.")
}
const routerPath = path.join(sourceRoot, "infrastructure", "webview", "WebviewBackendComposition.ts")
const router = fs.readFileSync(routerPath, "utf8")
for (const collaborator of ["WebviewFeatureRegistry", "WebviewRpcIngress", "WebviewRuntimeEventIngress", "WebviewStreamPublisher", "StateStreamRefreshCoordinator"]) {
	if (!router.includes(collaborator)) violations.push(`WebviewBackendComposition must delegate to ${collaborator}.`)
}
for (const focusedComposition of ["createWebviewRpcComposition", "createTaskHistoryComposition"]) {
	if (!router.includes(focusedComposition)) violations.push(`WebviewBackendComposition must retain focused wiring through ${focusedComposition}.`)
}
for (const migratedField of ["settingsRpc", "accountRpc", "browserRpc", "terminalRpc", "taskRpc", "checkpointRpc", "hookRpc", "scheduledAgentRpc", "worktreeRpc", "modelCatalogRpc", "fileRpc", "instructionSettingsRpc", "uiWebRpc", "pluginRpc"]) {
	if (router.includes(`private readonly ${migratedField}`)) violations.push(`WebviewBackendComposition must not restore transient RPC handler field ${migratedField}.`)
}
const unaryRouter = fs.readFileSync(path.join(sourceRoot, "infrastructure", "webview", "WebviewUnaryRpcRouter.ts"), "utf8")
for (const marker of ["HostProviderPort", "AgentEnginePort", "WebviewTransportPort", "InteractionLoggerPort"]) {
	if (!router.includes(marker)) violations.push(`VisualStudioWebviewBackend is missing application port: ${marker}`)
}
if (router.includes("VisualStudioHostProvider") || router.includes("sendHostRequest(")) {
	violations.push("VisualStudioWebviewBackend must not reference concrete host or transport implementations.")
}

const connectionFactory = fs.readFileSync(path.join(sourceRoot, "bootstrap", "SidecarConnectionFactory.ts"), "utf8")
if (!connectionFactory.includes("satisfies RuntimeWebviewFeatures") || !connectionFactory.includes("configureFeatures(features)")) {
	violations.push("SidecarConnectionFactory must atomically configure a compile-time complete RuntimeWebviewFeatures object.")
}
if (/\.set[A-Z][A-Za-z]+Handler\(/.test(connectionFactory)) {
	violations.push("SidecarConnectionFactory must not restore piecemeal feature setter injection.")
}
const featureRegistry = fs.readFileSync(path.join(sourceRoot, "infrastructure", "webview", "WebviewFeatureRegistry.ts"), "utf8")
if (!featureRegistry.includes("complete(features: RuntimeWebviewFeatures)") || !featureRegistry.includes("private sealed = false")) {
	violations.push("WebviewFeatureRegistry must reject partial or repeated runtime feature configuration.")
}
const unaryHandler = router.match(/private async handleUnaryRequest[\s\S]*?\n\t}\n\n\tprivate disposeStreamRequest/)?.[0] || ""
if (unaryHandler.includes("switch (key)")) {
	violations.push("VisualStudioWebviewBackend must dispatch unary WebView RPC through typed boundary decoders instead of owning a raw switch table.")
}
const streamingHandler = router.match(/private async handleStreamingRequest[\s\S]*?\n\t}\n\n\tprivate async handleUnaryRequest/)?.[0] || ""
if (streamingHandler.includes('key === "')) {
	violations.push("VisualStudioWebviewBackend must dispatch streaming WebView RPC through the typed streaming decoder.")
}
if (router.includes("runBrowserActionViaDevTools") || router.includes("browserSessions")) {
	violations.push("VisualStudioWebviewBackend must delegate browser execution and session ownership to BrowserHandler.")
}
if (!router.includes("RuntimeMonitoringCoordinator") || router.includes("isTerminalTaskStatus")) {
	violations.push("VisualStudioWebviewBackend must delegate runtime activity, partial-state, and latency coordination to RuntimeMonitoringCoordinator.")
}
if (!router.includes("TaskSessionCoordinator") || router.includes("closingSessionIds") || router.includes("private transitionTask") || router.includes("private shouldIgnoreSdkEvent")) {
	violations.push("VisualStudioWebviewBackend must delegate task/session ownership and lifecycle policy to TaskSessionCoordinator.")
}
if (!router.includes("StateStreamRefreshCoordinator") || router.includes("stateHydrationRefreshInFlight") || router.includes("private scheduleStateStreamsRefresh")) {
	violations.push("VisualStudioWebviewBackend must delegate delayed state hydration refresh policy to StateStreamRefreshCoordinator.")
}
if (!router.includes("TaskStateCoordinator") || router.includes("private updateCurrentTaskItem") || router.includes("private rememberTaskSnapshot")) {
	violations.push("VisualStudioWebviewBackend must delegate task metadata, history, snapshot, and persistence coordination to TaskStateCoordinator.")
}
if (!router.includes("TaskCompletionProjector") || router.includes("private finishSdkTask") || router.includes("private hasCompletionResultAfterLastUserMessage")) {
	violations.push("VisualStudioWebviewBackend must use TaskCompletionProjector directly instead of restoring completion forwarding methods.")
}
if (router.includes("private finalizeActivePartialText") || router.includes("private upsertFoldedReasoningText") || router.includes("private startTerminalStatePolling")) {
	violations.push("VisualStudioWebviewBackend must use conversation projectors and terminal activity adapters directly instead of restoring forwarding methods.")
}
if (!router.includes("ConversationRuntimeProjector") || router.includes("private upsertAssistantTextFromEvent") || router.includes("private recordToolActivity")) {
	violations.push("VisualStudioWebviewBackend must delegate assistant classification and tool-activity grouping to ConversationRuntimeProjector.")
}
if (!router.includes("ConversationCleanupCoordinator") || router.includes("private clearLiveInteractionState") || router.includes("private finalizeOpenPartialMessages")) {
	violations.push("VisualStudioWebviewBackend must delegate conversation cleanup ordering to ConversationCleanupCoordinator.")
}
if (router.includes("private completeFromSdkResult") || router.includes("private hydrateCurrentTaskFromSdk") || router.includes("private runLifecycleHooks")) {
	violations.push("VisualStudioWebviewBackend must call extracted chat, transcript, and hook flows directly instead of restoring forwarding methods.")
}
if (!router.includes("ToolApprovalFlow") || !router.includes("ToolApprovalPromptProjector") || router.includes("preToolUseInputPatched\", {")) {
	violations.push("VisualStudioWebviewBackend must delegate tool approval orchestration and prompt projection to the approvals slice.")
}
if (!router.includes("TaskPromptFlow") || router.includes("private async startNewTask") || router.includes("private async sendAskResponse")) {
	violations.push("VisualStudioWebviewBackend must delegate task prompt normalization and routing to TaskPromptFlow.")
}
if (!router.includes("BrowserToolEventFlow") || router.includes("private async handleBrowserToolEvent")) {
	violations.push("VisualStudioWebviewBackend must delegate browser tool execution transcript projection to BrowserToolEventFlow.")
}
if (!router.includes("ConversationActivityProjector") || router.includes("private handleReasoningDelta") || router.includes("private rememberToolSummary")) {
	violations.push("VisualStudioWebviewBackend must delegate reasoning status and tool-summary projection to ConversationActivityProjector.")
}
if (router.includes("private handleFileChangedEvent") || router.includes("private wasRecentlyTracked")) {
	violations.push("VisualStudioWebviewBackend must use ChangeTrackingHandler directly instead of restoring forwarding methods.")
}
if (!router.includes("RuntimeModelContext") || router.includes("private getModelId") || router.includes("private getResumedConversationCharBudget")) {
	violations.push("VisualStudioWebviewBackend must delegate runtime model selection and transcript budget policy to RuntimeModelContext.")
}
if (!router.includes("ToolRuntimePolicy") || router.includes("private createCurrentToolPolicies") || router.includes("private refreshWebToolFeatureState")) {
	violations.push("VisualStudioWebviewBackend must delegate tool policy and Web feature-state projection to ToolRuntimePolicy.")
}
if (!router.includes("WebviewInteractionLogSupport") || router.includes("function summarizeSdkEventForLog") || router.includes("function summarizeAgentChunkForLog")) {
	violations.push("VisualStudioWebviewBackend must delegate SDK interaction log projection to WebviewInteractionLogSupport.")
}
const rpcIngress = fs.readFileSync(path.join(sourceRoot, "infrastructure", "webview", "WebviewRpcIngress.ts"), "utf8")
if (!rpcIngress.includes("WebviewGrpcSupport") || rpcIngress.includes("function grpcResponse") || rpcIngress.includes("HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION")) {
	violations.push("WebviewRpcIngress must delegate gRPC envelope construction to WebviewGrpcSupport.")
}
if (router.includes("validateGrpcRequestContract") || router.includes("grpcError(") || router.includes("grpcHandled(")) {
	violations.push("VisualStudioWebviewBackend must delegate gRPC validation and error envelopes to WebviewRpcIngress.")
}
if (!router.includes("RuntimeErrorFormatter") || router.includes("function formatSdkErrorForUi") || router.includes("function stringify")) {
	violations.push("VisualStudioWebviewBackend must delegate runtime and provider error formatting to RuntimeErrorFormatter.")
}
if (!router.includes("AutoApprovalNotifier") || router.includes("private async notifyAutoApprovedTool")) {
	violations.push("VisualStudioWebviewBackend must delegate host auto-approval notifications to AutoApprovalNotifier.")
}
if (router.includes("private addMessage") || router.includes("private getCurrentSessionId")) {
	violations.push("VisualStudioWebviewBackend must use conversation and task-session collaborators directly instead of restoring forwarding methods.")
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
if (!unaryRouter.includes("WorktreeRpcHandler") || !/d\.worktree\.handle\((?:worktree|command)\)/.test(unaryRouter)) {
	violations.push("Worktree RPC routes must be delegated through WorktreeRpcHandler.")
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
const webviewSourceFiles = walk(webviewSourceRoot).filter((filePath) => /\.(ts|tsx)$/.test(filePath) && !filePath.endsWith(".d.ts"))
const webviewImportGraph = new Map(webviewSourceFiles.map((filePath) => [filePath, new Set()]))
for (const filePath of webviewSourceFiles) {
	const source = fs.readFileSync(filePath, "utf8")
	for (const specifier of importSpecifiers(filePath, source)) {
		if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue
		const target = resolveTypeScriptModule(filePath, specifier, webviewSourceRoot)
		if (target && webviewImportGraph.has(target)) webviewImportGraph.get(filePath).add(target)
	}
}
for (const component of stronglyConnectedComponents(webviewImportGraph).filter((items) => items.length > 1)) {
	const members = component.map((filePath) => normalize(path.relative(webviewSourceRoot, filePath))).sort()
	violations.push(`Circular WebView dependency: ${members.join(" -> ")}`)
}
const grpcClientBase = fs.readFileSync(path.join(webviewSourceRoot, "services", "grpcClientBase.ts"), "utf8")
if (!grpcClientBase.includes("WEBVIEW_RPC_PROTOCOL_VERSION") || !grpcClientBase.includes("protocol_version: WEBVIEW_RPC_PROTOCOL_VERSION")) {
	violations.push("WebView gRPC request envelopes must carry an explicit protocol version.")
}
const streamPublisherSource = fs.readFileSync(path.join(sourceRoot, "infrastructure", "webview", "WebviewStreamPublisher.ts"), "utf8")
const grpcSupportSource = fs.readFileSync(path.join(sourceRoot, "infrastructure", "webview", "WebviewGrpcSupport.ts"), "utf8")
if (!grpcSupportSource.includes("protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION") || !streamPublisherSource.includes("protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION")) {
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
for (const [relative, maxLines, requiredDelegates] of [
	["context/ExtensionStateContext.tsx", 300, ["ModelCatalogStateProvider", "NavigationStateProvider", "McpStateProvider", "RuntimeViewStateProvider", "TaskStreamStateProvider"]],
	["context/TaskStreamState.tsx", 300, ["ExtensionSubscriptions", "useNavigationStateContext", "useRuntimeViewStateContext"]],
	["components/chat/ChatRow.tsx", 500, ["ChatMessageRendererRegistry", "ToolMessageRenderer"]],
	["components/chat/ChatMessageRendererRegistry.tsx", 100, ["AskMessageRenderer", "SayMessageRenderer", "rendererRegistry"]],
	["components/chat/ChatTextArea.tsx", 750, ["ChatInputToolbar", "useContextMentionMenu", "useChatDrop", "useChatPaste", "useChatInputSubmit", "useSlashCommandMenu"]],
]) {
	const source = fs.readFileSync(path.join(webviewSourceRoot, relative), "utf8")
	if (source.split(/\r?\n/).length > maxLines) {
		violations.push(`${relative} exceeds its ${maxLines}-line WebView responsibility boundary.`)
	}
	for (const delegate of requiredDelegates) {
		if (!source.includes(delegate)) violations.push(`${relative} must delegate to ${delegate}.`)
	}
}
const sdkRuntime = fs.readFileSync(path.join(sourceRoot, "infrastructure", "sdk", "ClineSdkRuntime.ts"), "utf8")
const sdkEventSubscription = fs.readFileSync(path.join(sourceRoot, "infrastructure", "sdk", "ClineSdkEventSubscription.ts"), "utf8")
if (!sdkEventSubscription.includes("core.subscribe") || !sdkEventSubscription.includes("normalizeAgentRuntimeEvent(event)")) {
	violations.push("ClineSdkEventSubscription must normalize SDK events before publishing them internally.")
}
if (sdkRuntime.split(/\r?\n/).length > 250) {
	violations.push("ClineSdkRuntime must remain a thin AgentEnginePort adapter (250 lines maximum).")
}
for (const [relative, maxLines] of Object.entries({
	"ClineSdkCoreFactory.ts": 120,
	"ClineSdkEventSubscription.ts": 50,
	"ClineSdkMcpAdapter.ts": 500,
	"ClineSdkMcpSettingsStore.ts": 160,
	"ClineSdkProviderAdapter.ts": 50,
	"ClineSdkSessionAdapter.ts": 250,
	"ClineSdkToolExecutorFactory.ts": 250,
})) {
	const source = fs.readFileSync(path.join(sourceRoot, "infrastructure", "sdk", relative), "utf8")
	if (source.split(/\r?\n/).length > maxLines) {
		violations.push(`${relative} exceeds its ${maxLines}-line SDK responsibility boundary.`)
	}
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
	violations.push("VisualStudioWebviewBackend must delegate transcript conversion to the conversation projection modules.")
}

const conversationSupport = fs.readFileSync(path.join(sourceRoot, "infrastructure", "conversation", "ConversationSupport.ts"), "utf8")
if (conversationSupport.split(/\r?\n/).length > 50) {
	violations.push("ConversationSupport must remain a compatibility barrel (50 lines maximum).")
}
for (const relative of [
	"infrastructure/conversation/AgentChunkTranscriptConversion.ts",
	"infrastructure/conversation/ConversationMessageProjection.ts",
	"infrastructure/conversation/ResumedConversationProjection.ts",
	"infrastructure/conversation/SdkContentConversion.ts",
	"infrastructure/conversation/SdkMessageTranscriptProjection.ts",
	"infrastructure/conversation/ToolActivityFormatting.ts",
	"infrastructure/conversation/ToolCommandFormatting.ts",
	"infrastructure/conversation/TranscriptNormalization.ts",
]) {
	const source = fs.readFileSync(path.join(sourceRoot, relative), "utf8")
	if (source.split(/\r?\n/).length > 450) violations.push(`${relative} exceeds the 450-line conversation module boundary.`)
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

if (violations.length) {
	console.error("Clean Architecture dependency check failed:")
	for (const violation of violations) console.error(`- ${violation}`)
	process.exit(1)
}

console.log("AI maintenance architecture checks passed.")

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

function resolveTypeScriptModule(importerPath, specifier, aliasRoot) {
	const base = specifier.startsWith("@/") && aliasRoot
		? path.resolve(aliasRoot, specifier.slice(2))
		: path.resolve(path.dirname(importerPath), specifier)
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.normalize(candidate)
	}
	return undefined
}

function stronglyConnectedComponents(graph) {
	let nextIndex = 0
	const indexes = new Map()
	const lowLinks = new Map()
	const stack = []
	const onStack = new Set()
	const components = []

	for (const node of graph.keys()) {
		if (!indexes.has(node)) visit(node)
	}
	return components

	function visit(node) {
		indexes.set(node, nextIndex)
		lowLinks.set(node, nextIndex)
		nextIndex++
		stack.push(node)
		onStack.add(node)

		for (const target of graph.get(node) || []) {
			if (!indexes.has(target)) {
				visit(target)
				lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)))
			} else if (onStack.has(target)) {
				lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)))
			}
		}

		if (lowLinks.get(node) !== indexes.get(node)) return
		const component = []
		let member
		do {
			member = stack.pop()
			onStack.delete(member)
			component.push(member)
		} while (member !== node)
		components.push(component)
	}
}

function normalize(value) {
	return value.replace(/\\/g, "/")
}
