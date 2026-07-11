import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = fs.readFileSync(path.join(root, "src", "services", "grpcClient.ts"), "utf8")
const violations = []

if (!source.includes("interface UiServiceContract")) {
	violations.push("UiServiceClient must expose an operation-specific contract.")
}
for (const service of [
	"UiServiceClient",
	"CheckpointsServiceClient",
	"SlashServiceClient",
	"BrowserServiceClient",
	"WebServiceClient",
	"OcaAccountServiceClient",
	"WorktreeServiceClient",
	"McpServiceClient",
	"AccountServiceClient",
	"FileServiceClient",
]) {
	if (new RegExp(`${service}\\s*:\\s*any\\b`).test(source)) {
		violations.push(`${service} must not be exported as any.`)
	}
}

for (const operation of [
	"openImage",
	"openFile",
	"openFileRelativePath",
	"openVsClineDiff",
	"revertVsClineChanges",
	"copyToClipboard",
	"openDiskConversationHistory",
	"openFocusChainFile",
	"openMention",
	"ifFileExistsRelativePath",
	"selectFiles",
	"searchFiles",
	"searchCommits",
	"getRelativePaths",
	"refreshRules",
	"refreshHooks",
	"refreshSkills",
	"toggleClineRule",
	"toggleCursorRule",
	"toggleWindsurfRule",
	"toggleAgentsRule",
	"toggleHook",
	"toggleWorkflow",
	"toggleSkill",
	"createHook",
	"deleteHook",
	"createRuleFile",
	"deleteRuleFile",
	"createSkillFile",
	"deleteSkillFile",
]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`FileServiceContract is missing ${operation}.`)
	}
}

for (const operation of [
	"accountLoginClicked",
	"accountLogoutClicked",
	"getUserOrganizations",
	"subscribeToAuthStatusUpdate",
	"getUserCredits",
	"getOrganizationCredits",
	"setUserOrganization",
	"getRedirectUrl",
	"submitLimitIncreaseRequest",
	"hicapAuthClicked",
	"openrouterAuthClicked",
	"requestyAuthClicked",
	"openAiCodexSignIn",
	"openAiCodexSignOut",
]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`AccountServiceContract is missing ${operation}.`)
	}
}

for (const operation of [
	"refreshMcpMarketplace",
	"getLatestMcpServers",
	"addRemoteMcpServer",
	"downloadMcp",
	"openMcpSettings",
	"updateMcpTimeout",
	"restartMcpServer",
	"deleteMcpServer",
	"toggleToolAutoApprove",
	"toggleMcpServer",
	"authenticateMcpServer",
]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`McpServiceContract is missing ${operation}.`)
	}
}

for (const operation of [
	"listWorktrees",
	"getWorktreeIncludeStatus",
	"createWorktreeInclude",
	"getWorktreeDefaults",
	"createWorktree",
	"deleteWorktree",
	"switchWorktree",
	"mergeWorktree",
	"trackWorktreeViewOpened",
]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`WorktreeServiceContract is missing ${operation}.`)
	}
}

for (const operation of ["ocaAccountLoginClicked", "ocaAccountLogoutClicked", "ocaSubscribeToAuthStatusUpdate"]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`OcaAccountServiceContract is missing ${operation}.`)
	}
}

for (const operation of ["fetchOpenGraphData", "checkIsImageUrl", "openInBrowser"]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`WebServiceContract is missing ${operation}.`)
	}
}

for (const operation of [
	"initializeWebview",
	"openUrl",
	"setTerminalExecutionMode",
	"subscribeToPartialMessage",
	"subscribeToShowWebview",
	"subscribeToAddToInput",
]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`UiServiceContract is missing ${operation}.`)
	}
}

for (const operation of ["checkpointRestore", "checkpointDiff", "condense", "reportBug"]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`Typed RPC contracts are missing ${operation}.`)
	}
}

for (const operation of [
	"getBrowserConnectionInfo",
	"getDetectedChromePath",
	"testBrowserConnection",
	"discoverBrowser",
	"relaunchChromeDebugMode",
]) {
	if (!new RegExp(`\\b${operation}:`).test(source)) {
		violations.push(`BrowserServiceContract is missing ${operation}.`)
	}
}

if (violations.length) {
	for (const violation of violations) console.error(`- ${violation}`)
	process.exit(1)
}

console.log("WebView RPC contract audit passed.")
