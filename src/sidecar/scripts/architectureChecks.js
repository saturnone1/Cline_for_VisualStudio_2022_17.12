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
const webviewController = fs.readFileSync(controllerPath, "utf8")
if (!webviewController.includes("parseHostSidecarWebviewRequest") || !webviewController.includes("createHostSidecarWebviewResponse")) {
	violations.push("VisualStudioWebviewController must enforce the versioned host-sidecar WebView contract.")
}
const sdkRuntime = fs.readFileSync(path.join(sourceRoot, "infrastructure", "sdk", "ClineSdkRuntime.ts"), "utf8")
if (!sdkRuntime.includes("normalizeAgentRuntimeEvent(event)")) {
	violations.push("ClineSdkRuntime must normalize SDK events before publishing them internally.")
}
const sdkEventTranslator = fs.readFileSync(path.join(sourceRoot, "infrastructure", "sdk", "ClineSdkEventTranslator.ts"), "utf8")
for (const eventName of ["AgentStarted", "TextDelta", "ReasoningDelta", "ToolCallRequested", "ToolCallCompleted", "ApprovalRequested", "AgentCompleted", "AgentFailed"]) {
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
	"application/dto/OAuthContracts.ts",
	"features/mcp/McpHandler.ts",
	"application/useCases/StatePersistenceUseCase.ts",
	"application/useCases/TaskLifecycleUseCase.ts",
	"application/useCases/TaskSessionUseCase.ts",
	"infrastructure/persistence/JsonStateStore.ts",
	"infrastructure/browser/BrowserDevToolsAdapter.ts",
	"infrastructure/conversation/ConversationSupport.ts",
	"infrastructure/configuration/ProviderConfiguration.ts",
	"infrastructure/auth/ProviderAuthSupport.ts",
	"infrastructure/auth/NodeOAuthCallbackListener.ts",
	"infrastructure/auth/FetchOAuthTokenExchangeAdapter.ts",
	"infrastructure/auth/ProviderCredentialEnvironmentAdapter.ts",
	"infrastructure/auth/VisualStudioProviderAuthUiAdapter.ts",
	"infrastructure/auth/ProviderOAuthAuthorizationAdapter.ts",
	"infrastructure/hooks/HookRuntime.ts",
	"infrastructure/models/ModelCatalog.ts",
	"infrastructure/persistence/LocalAutomationStore.ts",
	"infrastructure/worktree/WorktreeSupport.ts",
	"infrastructure/worktree/NodeWorktreeOperationsAdapter.ts",
	"infrastructure/webview/WebviewState.ts",
	"infrastructure/transport/SidecarRpcServer.ts",
	"features/chat/sendMessage/SendMessageCommand.ts",
	"features/chat/sendMessage/SendMessageHandler.ts",
	"features/chat/startTask/StartTaskCommand.ts",
	"features/chat/startTask/StartTaskHandler.ts",
	"features/chat/cancelTask/CancelTaskCommand.ts",
	"features/chat/cancelTask/CancelTaskHandler.ts",
	"features/approvals/ApprovalCoordinator.ts",
	"features/taskHistory/TaskHistoryCollection.ts",
	"features/providers/ProviderSelection.ts",
	"features/providers/OAuthCallbackCoordinator.ts",
	"features/providers/OAuthCallbackHandler.ts",
	"features/providers/OAuthAuthorizationHandler.ts",
	"features/providers/OAuthTokenHandler.ts",
	"features/providers/ProviderCredentialPolicy.ts",
	"features/providers/ProviderCredentialHandler.ts",
	"features/providers/ProviderAuthActionPolicy.ts",
	"features/providers/ProviderAuthActionHandler.ts",
	"features/settings/PlanActMode.ts",
	"features/worktrees/WorktreePolicy.ts",
	"features/worktrees/WorktreeQueryHandler.ts",
	"features/worktrees/WorktreeMutationHandler.ts",
	"features/browser/BrowserPolicy.ts",
	"features/browser/BrowserHandler.ts",
	"features/hooks/HookPolicy.ts",
	"features/scheduledAgents/ScheduledAgentPolicy.ts",
	"features/checkpoints/CheckpointPolicy.ts",
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
