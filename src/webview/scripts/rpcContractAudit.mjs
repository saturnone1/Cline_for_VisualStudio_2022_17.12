import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = fs.readFileSync(path.join(root, "src", "services", "grpcClient.ts"), "utf8")
const violations = []

if (!source.includes("interface UiServiceContract")) {
	violations.push("UiServiceClient must expose an operation-specific contract.")
}
if (/UiServiceClient\s*:\s*any\b/.test(source)) {
	violations.push("UiServiceClient must not be exported as any.")
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

if (violations.length) {
	for (const violation of violations) console.error(`- ${violation}`)
	process.exit(1)
}

console.log("WebView RPC contract audit passed.")
