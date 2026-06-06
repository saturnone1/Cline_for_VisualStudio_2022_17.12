const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const routerPath = path.join(root, "src", "webview", "VisualStudioWebviewRouter.ts")
const router = fs.readFileSync(routerPath, "utf8")

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
const snapshotFallback = router.indexOf('this.taskSnapshots.get(taskId)', showTaskWithIdStart)
const sdkActivation = router.indexOf("this.clineSdk.activateSession(taskId)", showTaskWithIdStart)
if (showTaskWithIdStart < 0 || snapshotFallback < 0 || sdkActivation < 0 || snapshotFallback > sdkActivation) {
	console.error("VS2022 SDK parity smoke failed. showTaskWithId must restore cached transcript snapshots before SDK hydration.")
	process.exit(1)
}

console.log(`VS2022 SDK parity smoke passed (${requiredMarkers.length} markers).`)
