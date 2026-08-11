import type { FileCommand } from "../../features/files/FileRpcHandler"

export function decodeFileRpcCommand(key: string, message: unknown): FileCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "FileService.createRuleFile": return { type: "createRule", request: ruleRequest(request) }
		case "FileService.deleteRuleFile": return { type: "deleteRule", request: ruleRequest(request) }
		case "FileService.createSkillFile": return { type: "createSkill", request: skillRequest(request) }
		case "FileService.deleteSkillFile": return { type: "deleteSkill", request: skillRequest(request) }
		case "FileService.openMention": return { type: "openMention", value: readString(request.value) }
		case "FileService.openDiskConversationHistory": return { type: "openHistory", taskId: readString(request.value) }
		case "FileService.openFocusChainFile": return { type: "openFocus", taskId: readString(request.value) }
		case "FileService.openImage": return { type: "openImage", value: readString(request.value) }
		case "FileService.openVsClineDiff": return { type: "openDiff", leftPath: readString(request.leftPath) || readString(request.beforePath), rightPath: readString(request.rightPath) || readString(request.afterPath) || readString(request.filePath), title: readString(request.title) }
		case "FileService.revertVsClineChanges": return { type: "revert", request: { files: arrayOfRecords(request.files).map((file) => ({ filePath: readString(file.filePath), beforePath: readString(file.beforePath), action: readString(file.action) || "modified" })) } }
		case "FileService.copyToClipboard": return { type: "copy", text: readString(request.value) || readString(request.text) }
		case "FileService.ifFileExistsRelativePath": return { type: "exists", relativePath: readString(request.value) || readString(request.path) || readString(request.relativePath) }
		case "FileService.getRelativePaths": return { type: "relativePaths", uris: stringArray(request.uris) }
		case "FileService.searchFiles": return {
			type: "searchFiles",
			query: readString(request.query) || readString(request.value),
			selectedType: readFileSearchType(request.selectedType),
			workspaceHint: readString(request.workspaceHint),
		}
		case "FileService.searchCommits": return { type: "searchCommits", query: readString(request.value) || readString(request.query) }
		case "FileService.selectFiles": return { type: "select", allowImages: request.value === true || request.allowImages === true }
		case "FileService.openFile":
		case "FileService.openFileRelativePath": return { type: "openFile", filePath: readString(request.filePath) || readString(request.path) || readString(request.value) || readString(request.relativePath), line: optionalNumber(request.line) }
		default: return undefined
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function arrayOfRecords(value: unknown) { return Array.isArray(value) ? value.map(asRecord) : [] }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [] }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function readFileSearchType(value: unknown): "FILE" | "FOLDER" | undefined { return value === "FILE" || value === "FOLDER" ? value : undefined }
function optionalNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function ruleRequest(value: Record<string, unknown>) { return { isGlobal: value.isGlobal === true, filename: readString(value.filename), rulePath: readString(value.rulePath), type: readString(value.type) } }
function skillRequest(value: Record<string, unknown>) { return { isGlobal: value.isGlobal === true, skillName: readString(value.skillName), skillPath: readString(value.skillPath) } }
