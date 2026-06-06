import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const files = [
	"src/components/chat/ChatTextArea.tsx",
	"src/components/chat/CommandOutputRow.tsx",
	"src/components/chat/BrowserSessionRow.tsx",
	"src/components/chat/SubagentStatusRow.tsx",
	"src/components/settings/PreferredLanguageSetting.tsx",
	"src/components/chat/auto-approve-menu/AutoApproveBar.tsx",
	"src/components/chat/auto-approve-menu/AutoApproveModal.tsx",
]

const blocked = [
	/Add Context/,
	/Add Files & Images/,
	/Auto-approve:/,
	/Enable notifications/,
	/LIG VS wants to use the browser:/,
	/LIG VS가 브라우저를 사용하려고 합니다:/,
	/서브에이전트 상태를 표시할 수 없습니다/,
]

const failures = []
for (const file of files) {
	const text = readFileSync(join(root, file), "utf8")
	for (const pattern of blocked) {
		if (pattern.test(text)) {
			failures.push(`${file}: ${pattern}`)
		}
	}
}

if (failures.length > 0) {
	console.error("i18n audit failed; use t(...) or language-aware helpers for UI strings:")
	for (const failure of failures) {
		console.error(`- ${failure}`)
	}
	process.exit(1)
}

console.log(`i18n audit passed (${files.length} high-traffic files)`)
