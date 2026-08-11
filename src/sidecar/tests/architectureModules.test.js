const assert = require("node:assert/strict")
const test = require("node:test")
const { normalizeProviderId, normalizeSdkProviderId, oauthCredentialsField } = require("../dist/application/services/ProviderIdentity")
const { createFallbackProviderConfigFields, redactUrl } = require("../dist/infrastructure/auth/ProviderAuthSupport")
const { extractHookJsonResponse, hookDecisionFromResponse } = require("../dist/features/hooks/HookPolicy")
const { parseGitWorktreePorcelain } = require("../dist/features/worktrees/WorktreePolicy")
const {
	createInitialState,
	createPersistedStateSnapshot,
	loadInitialState,
} = require("../dist/infrastructure/webview/WebviewState")

test("provider identity keeps SDK aliases separate from persisted provider ids", () => {
	assert.equal(normalizeProviderId("OPENAI_CODEX"), "openai-codex")
	assert.equal(normalizeSdkProviderId("openai"), "openai-compatible")
	assert.equal(oauthCredentialsField("openai-codex"), "openAiCodexOAuthCredentials")
})

test("provider authentication fallback exposes supported fields without secrets", () => {
	const fallback = createFallbackProviderConfigFields("openrouter")
	assert.equal(fallback.providerId, "openrouter")
	assert.equal(fallback.authMethod, "api-key")
	assert.ok(fallback.fields.apiKey)
	assert.equal(redactUrl("https://example.test/callback?code=secret&state=visible"), "https://example.test/callback")
})

test("hook responses use the last structured line and preserve deny decisions", () => {
	const response = extractHookJsonResponse('diagnostic\n{"decision":"deny","reason":"policy"}')
	assert.deepEqual(hookDecisionFromResponse(response), {
		blocked: true,
		reason: "policy",
		inputPatch: undefined,
		replaceInput: false,
		validationMessage: "",
		contextPatch: undefined,
		structuredDecision: { action: "deny", severity: undefined, category: undefined },
	})
})

test("worktree porcelain parsing retains branch and lock metadata", () => {
	const parsed = parseGitWorktreePorcelain("worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\nlocked maintenance\n")
	assert.deepEqual(parsed, [{
		path: "C:/repo",
		branch: "main",
		head: "abc123",
		isBare: false,
		isDetached: false,
		isLocked: true,
		isPrunable: false,
		isCurrent: false,
		lockReason: "maintenance",
	}])
})

test("webview state persistence restores user settings and omits transient state", () => {
	const state = createInitialState()
	state.uiLanguage = "en"
	state.customPrompt = "Review carefully"
	state.shellIntegrationTimeout = 4_500
	state.terminalReuseEnabled = false
	state.terminalOutputLineLimit = 900
	state.defaultTerminalProfile = "windows-powershell"
	state.backgroundCommandRunning = true
	state.taskLifecycleStatus = "streaming"
	const restored = loadInitialState(createPersistedStateSnapshot(state))

	assert.equal(restored.uiLanguage, "en")
	assert.equal(restored.customPrompt, "Review carefully")
	assert.equal(restored.shellIntegrationTimeout, 4_500)
	assert.equal(restored.terminalReuseEnabled, false)
	assert.equal(restored.terminalOutputLineLimit, 900)
	assert.equal(restored.defaultTerminalProfile, "windows-powershell")
	assert.equal(restored.backgroundCommandRunning, false)
	assert.equal(restored.taskLifecycleStatus, "idle")
})

test("legacy automatic-compaction defaults migrate once without overriding later user choice", () => {
	const legacy = loadInitialState({ useAutoCondense: false })
	assert.equal(legacy.useAutoCondense, true)
	assert.equal(legacy.autoCondensePreferenceVersion, 1)

	const configured = loadInitialState({ useAutoCondense: false, autoCondensePreferenceVersion: 1 })
	assert.equal(configured.useAutoCondense, false)
	assert.equal(createPersistedStateSnapshot(configured).autoCondensePreferenceVersion, 1)
})

test("persisted transcripts migrate legacy SDK status rows in current and historical tasks", () => {
	const restored = loadInitialState({
		currentTaskItem: { id: "current" },
		clineMessages: [
			{ type: "say", say: "text", text: "auto-compacting" },
			{ type: "say", say: "text", text: "현재 응답" },
		],
		taskSnapshots: {
			old: {
				taskItem: { id: "old" },
				messages: [
					{ type: "say", say: "text", text: "auto-compacted" },
					{ type: "say", say: "text", text: "과거 응답" },
				],
			},
		},
	})

	assert.deepEqual(restored.clineMessages.map((message) => message.text), ["현재 응답"])
	assert.deepEqual(restored.taskSnapshots.old.messages.map((message) => message.text), ["과거 응답"])
})
