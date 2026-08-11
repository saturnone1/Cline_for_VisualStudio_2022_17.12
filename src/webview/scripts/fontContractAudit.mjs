import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const css = fs.readFileSync(path.join(root, "src", "main.css"), "utf8")
const chatTextArea = fs.readFileSync(path.join(root, "src", "components", "chat", "ChatTextArea.tsx"), "utf8")
const failures = []

if (!css.includes('"Noto Sans KR"')) failures.push("Noto Sans KR is missing from the WebView font stack.")
if (!/:where\(\.codicon\[class\*=["']codicon-["']\]\)\s*\{[^}]*font-family:\s*codicon\s*!important/s.test(css)) {
	failures.push("Codicon elements must opt out of the global Noto Sans KR override.")
}
if (!chatTextArea.includes('requestPending ? "codicon-debug-stop" : "codicon-send"')) {
	failures.push("The chat send/cancel control must use Codicon classes instead of font-dependent Unicode symbols.")
}

if (failures.length) {
	console.error("WebView font contract audit failed:")
	for (const failure of failures) console.error(`- ${failure}`)
	process.exit(1)
}

console.log("WebView font contract audit passed.")
