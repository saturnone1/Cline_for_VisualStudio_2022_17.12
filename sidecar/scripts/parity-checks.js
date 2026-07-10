const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const routerPath = path.join(root, "src", "webview", "VisualStudioWebviewRouter.ts")
const sdkRuntimePath = path.join(root, "src", "sdk", "ClineSdkRuntime.ts")
const mainPath = path.join(root, "src", "main.ts")
const repoRoot = path.resolve(root, "..")
const apiConfigurationSectionPath = path.join(repoRoot, "webview-ui", "src", "components", "settings", "sections", "ApiConfigurationSection.tsx")
const generalSettingsSectionPath = path.join(repoRoot, "webview-ui", "src", "components", "settings", "sections", "GeneralSettingsSection.tsx")
const router = fs.readFileSync(routerPath, "utf8")
const sdkRuntime = fs.readFileSync(sdkRuntimePath, "utf8")
const main = fs.readFileSync(mainPath, "utf8")
const apiConfigurationSection = fs.readFileSync(apiConfigurationSectionPath, "utf8")
const generalSettingsSection = fs.readFileSync(generalSettingsSectionPath, "utf8")

const requiredMarkers = [
	["command text normalization", "function getCommandText"],
	["array command handling", "Array.isArray(commands)"],
	["progress phase splitting", "type ProgressPhase"],
	["progress phase transitions", "beginProgressPhase"],
	["MCP reduced marketplace diagnostics", "getMcpMarketplaceResponse"],
	["MCP marketplace air-gap reason", "MCP marketplace installation is not implemented"],
	["browser DevTools session registry", "browserSessions"],
	["browser action execution phases", "runBrowserActionViaDevTools"],
	["OAuth refresh state RPC", "refreshOAuthCredential"],
	["checkpoint compare RPC", "checkpointDiff"],
	["worktree merge recovery", "recoverWorktreeMerge"],
	["scheduled agent local spec directory", "\"cron\""],
	["local plugin discovery", "discoverLocalPlugins"],
	["provider catalog diagnostics", "createCatalogDiagnostics"],
	["90 percent supported diagnostics", "Provider catalog refresh diagnostics"],
	["checkpoint reduced SDK limitation", "SDK checkpoint diff streams"],
	["send latency diagnostics", "sendLatency.firstSdkEvent"],
	["debounced persisted state save", "schedulePersistedStateSave"],
	["provider rate-limit transcript label", "Model provider response: rate limit exceeded."],
	["targeted plan act toggle", "resolveRequestedPlanActMode"],
	["plan mode tool policy block", "isPlanModeBlockedTool"],
	["follow-up pending progress row", "Preparing response."],
	["SDK send mode propagation", "mode: this.state.mode === \"plan\" ? \"plan\" : \"act\""],
	["cached history immediate response", "refreshTaskHistoryFromSdkInBackground"],
	["live transcript hydrate protection", "stateHydration.selectedTaskSkipped"],
	["completion payload field fallback", "extractCompletionTextFromResult"],
	["completion after progress guard", "hasAssistantTextAfterLastUserOrProgressMessage"],
	["missing SDK session resumes from selected task", "resumeSdkSessionForSend(sessionId, sendParams, textLength)"],
	["missing SDK session preserves restored transcript context", "buildResumedConversationMessages"],
	["persisted state flush on sidecar dispose", "flushPersistedStateSave"],
	["persisted state save on message mutation", "this.schedulePersistedStateSave()"],
	["persisted task snapshots", "taskSnapshots: state.taskSnapshots"],
	["restart task snapshot restore", "this.getTaskSnapshot(taskId)"],
	["long API timeout default", "VSCLINE_API_TIMEOUT_MS\", 600_000"],
	["long idle watchdog default", "VSCLINE_TASK_IDLE_COMPLETE_MS\", 600_000"],
	["MCP server stream updates after mutations", "buildMcpServerStreamMessages(response)"],
	["stream cancellation cleanup", "disposeStreamRequest"],
	["API profile snapshot replacement", "applyApiConfigurationProfileSnapshot"],
]

const missing = requiredMarkers.filter(([, marker]) => !router.includes(marker))

if (missing.length > 0) {
	console.error("VS2022 SDK parity smoke failed. Missing markers:")
	for (const [label, marker] of missing) {
		console.error(`- ${label}: ${marker}`)
	}
	process.exit(1)
}

const showTaskWithIdStart = router.indexOf("private async showTaskWithId")
const snapshotFallback = router.indexOf("this.getTaskSnapshot(taskId)", showTaskWithIdStart)
const sdkActivation = router.indexOf("this.clineSdk.activateSession(taskId)", showTaskWithIdStart)
if (showTaskWithIdStart < 0 || snapshotFallback < 0 || sdkActivation < 0 || snapshotFallback > sdkActivation) {
	console.error("VS2022 SDK parity smoke failed. showTaskWithId must restore cached transcript snapshots before SDK hydration.")
	process.exit(1)
}

function fail(message) {
	console.error(`VS2022 SDK parity smoke failed. ${message}`)
	process.exit(1)
}

function requireSequence(label, source, markers) {
	let cursor = -1
	for (const marker of markers) {
		const next = source.indexOf(marker, cursor + 1)
		if (next < 0) {
			fail(`${label} is missing ordered marker: ${marker}`)
		}
		if (next < cursor) {
			fail(`${label} markers are out of order around: ${marker}`)
		}
		cursor = next
	}
}

function requireMatch(label, source, pattern) {
	if (!pattern.test(source)) {
		fail(`${label} did not match ${pattern}`)
	}
}

const inertStreamingStart = router.indexOf("private readonly inertStreams")
const inertStreamingEnd = router.indexOf("])", inertStreamingStart)
const inertStreamingBlock = inertStreamingStart >= 0 && inertStreamingEnd >= 0 ? router.slice(inertStreamingStart, inertStreamingEnd) : ""
if (inertStreamingBlock.includes("McpService.subscribeToMcpServers")) {
	fail("MCP server subscription must not be handled as an inert lazy stream.")
}

requireSequence("MCP server subscription", router, [
	'if (key === "McpService.subscribeToMcpServers")',
	"this.mcpServerStreamRequestIds.add(requestId)",
	"await this.getMcpServersResponse()",
])

requireSequence("MCP server stream cancellation", router, [
	'if (envelope?.type === "grpc_request_cancel")',
	"this.disposeStreamRequest(requestId)",
	"grpc_request_cancel.streamDisposed",
])
requireSequence("all stream registries are cleaned", router, [
	"private disposeStreamRequest(requestId: string)",
	"this.stateStreamRequestIds.delete(requestId)",
	"this.partialMessageStreamRequestIds.delete(requestId)",
	"this.mcpServerStreamRequestIds.delete(requestId)",
	"this.lastStateBroadcastKeys.delete(requestId)",
	"this.lastPartialMessageKeys.delete(requestId)",
])

for (const rpc of [
	"addRemoteMcpServer",
	"updateMcpTimeout",
	"restartMcpServer",
	"deleteMcpServer",
	"toggleToolAutoApprove",
	"toggleMcpServer",
	"authenticateMcpServer",
]) {
	requireMatch(`MCP mutation ${rpc}`, router, new RegExp(`case "McpService\\.${rpc}":[\\s\\S]{0,240}return this\\.grpcMcpServersMutation\\(requestId, await`))
}

requireSequence("missing SDK session resume prompt", router, [
	"private async resumeSdkSessionForSend",
	"void this.runLifecycleHooks(\"TaskResume\"",
	"const initialMessages = buildResumedConversationMessages(",
	"this.getResumedConversationCharBudget()",
	"prompt,",
	"initialMessages,",
	"sessionMetadata: taskTitle",
])

requireSequence("resumed transcript respects configured context window", router, [
	"private getResumedConversationCharBudget()",
	"resolveConfiguredContextWindow",
	"Math.floor(contextWindowTokens * 0.5)",
])

requireSequence("SDK restored transcript transport", sdkRuntime, [
	"const initialMessages = sdkInitialMessages(request.initialMessages)",
	"initialMessages: initialMessages.length > 0 ? initialMessages : undefined",
])

requireSequence("sidecar shutdown state flush", main, [
	"const activeRouters = new Set<VisualStudioWebviewRouter>()",
	"process.on(\"SIGTERM\", () => void flushAndExit(0))",
	"router.dispose()",
	"runtime.dispose()",
])

requireSequence("persisted state message mutation saves", router, [
	"private addMessage(message: Record<string, unknown>)",
	"this.state.clineMessages.push(normalizedMessage)",
	"this.schedulePersistedStateSave()",
	"private upsertMessage(ts: number, updates: Record<string, unknown>)",
	"const normalized = normalizeClineMessagePayload",
	"this.state.clineMessages[index] = normalized",
	"this.schedulePersistedStateSave()",
	"private updateCurrentTaskItem(updates?: Record<string, unknown>)",
	"this.rememberTaskSnapshot",
	"this.schedulePersistedStateSave()",
])

requireMatch(
	"persisted task snapshots initial state",
	router,
	/taskSnapshots: \{\} as Record<string, \{ taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> \}>/,
)
requireSequence("persisted task snapshots load/save", router, [
	"const taskSnapshots = asRecord(persisted.taskSnapshots)",
	"state.taskSnapshots[taskId] = normalized",
	"taskSnapshots: state.taskSnapshots",
])

requireSequence("API profile activation replaces active configuration", router, [
	"private activateApiConfigurationProfile(profileId: string)",
	"this.state.activeApiConfigurationProfileId = getString(profile, \"id\")",
	"this.applyApiConfigurationProfileSnapshot(profile)",
	"private applyApiConfigurationProfileSnapshot(profile: Record<string, unknown>)",
	"this.state.apiConfiguration = normalizeApiConfiguration(profileApiConfiguration)",
])
requireMatch(
	"API profile activation must not merge previous active API config into selected profile",
	router,
	/private applyApiConfigurationProfileSnapshot\(profile: Record<string, unknown>\) \{[\s\S]{0,420}this\.state\.apiConfiguration = normalizeApiConfiguration\(profileApiConfiguration\)/,
)
requireSequence("custom prompt draft protection", generalSettingsSection, [
	"const [isEditingCustomPrompt, setIsEditingCustomPrompt] = useState(false)",
	"if (!isEditingCustomPrompt) {",
	"setLocalCustomPrompt(incoming)",
	"onBlur={() => {",
	"saveCustomPrompt(localCustomPrompt)",
])
requireSequence("API profile pending and error UI", apiConfigurationSection, [
	"const [profileOperationPending, setProfileOperationPending] = useState(false)",
	"setProfileOperationPending(true)",
	"setProfileError(t(\"settings.apiProfiles.error\"))",
	"disabled={profileOperationPending}",
])
requireMatch("API profile IDs use UUID fallback", apiConfigurationSection, /globalThis\.crypto\?\.randomUUID\?\.\(\)[\s\S]{0,180}Math\.random\(\)\.toString\(36\)/)

requireSequence("task snapshot helpers sync memory and persisted state", router, [
	"private rememberTaskSnapshot(taskId: string, taskItem: Record<string, unknown>, messages: Array<Record<string, unknown>>)",
	"this.taskSnapshots.set(taskId, snapshot)",
	"this.state.taskSnapshots =",
	"private forgetTaskSnapshot(taskId: string)",
	"delete next[taskId]",
	"private clearTaskSnapshots()",
	"this.state.taskSnapshots = {}",
])

requireSequence("resumed conversation message limits", router, [
	"const RESUMED_CONVERSATION_MAX_MESSAGES = 40",
	"const RESUMED_CONVERSATION_MAX_CHARS = 20_000",
	"while (entries.length > 0 && normalizeTranscriptText(entries[entries.length - 1].text) === normalizeTranscriptText(currentPrompt))",
	"const restored: Array<{ role: \"user\" | \"assistant\"; content: string }>",
	"return restored",
])
if (router.includes("Visual Studio restarted. Use it as context") || router.includes("Visual Studio 재시작 후 복원된")) {
	fail("restored transcripts must not be embedded in a visible user prompt.")
}

requireMatch("long API timeout default", router, /readPositiveIntEnv\("VSCLINE_API_TIMEOUT_MS", 600_000\)/)
requireMatch("long idle watchdog default", router, /readPositiveIntEnv\("VSCLINE_TASK_IDLE_COMPLETE_MS", 600_000\)/)
requireMatch("web fetch controlled by browser settings", router, /function isWebFetchEnabled\(browserSettings: unknown\) \{[\s\S]{0,180}return settings\.disableToolUse !== true/)
requireMatch("skills tool enabled by default", router, /skills: \{ enabled: true, autoApprove: false \}/)
if (router.includes("VSCLINE_ENABLE_WEB_FETCH") || sdkRuntime.includes("VSCLINE_ENABLE_WEB_FETCH")) {
	fail("web fetch must be controlled by user settings, not an environment-variable gate.")
}
requireSequence("serialized atomic MCP settings writes", sdkRuntime, [
	"private mcpSettingsMutationQueue: Promise<void> = Promise.resolve()",
	"private async mutateMcpSettings(",
	"this.mcpSettingsMutationQueue.then(async () =>",
	"await this.saveMcpSettings(sdk, settings)",
	"private async saveMcpSettings(",
	"await writeFileAtomic(`${filePath}.bak`, previous)",
	"await writeFileAtomic(filePath, content)",
])
requireMatch("MCP empty/corrupt settings recovery", sdkRuntime, /private ensureMcpSettingsFile[\s\S]{0,900}\.corrupt-\$\{Date\.now\(\)\}[\s\S]{0,300}writeFileAtomicSync/)
if (sdkRuntime.includes("fs.promises.writeFile(filePath")) {
	fail("MCP settings must never be truncated in place.")
}
requireMatch("MCP tools attached to SDK sessions", sdkRuntime, /extraTools: await this\.createMcpExtraToolsForSession\(\)/)
requireMatch("SDK sends the user's prompt unchanged", sdkRuntime, /return await core\.send\(\{[\s\S]{0,120}prompt: stringValue\(request\.prompt\) \|\| ""/)
if (sdkRuntime.includes("<lig-vs-mcp-context>")) {
	fail("MCP status context must not be injected into user or system prompts.")
}
requireSequence("MCP mutations refresh SDK session tools", router, [
	"private grpcMcpServersMutation(requestId: string, response: unknown)",
	"this.runtimeSettingsRevision++",
	"this.buildMcpServerStreamMessages(response)",
])
requireMatch("legacy MCP prompt context is hidden", router, /function stripLegacyMcpContext[\s\S]{0,180}<lig-vs-mcp-context>/)

for (const method of [
	"authenticateMcpServer",
	"addRemoteMcpServer",
	"setMcpServerDisabled",
	"deleteMcpServer",
	"restartMcpServer",
]) {
	requireMatch(
		`SDK MCP operation ${method}`,
		sdkRuntime,
		new RegExp(`async ${method}\\([\\s\\S]*?await this\\.withMcpOperation\\([\\s\\S]*?\\n\\s*\\}\\)\\n\\s*return this\\.getMcpServersResponse\\(\\)`),
	)
}

console.log(`VS2022 SDK parity smoke passed (${requiredMarkers.length} markers and behavioral guards).`)
