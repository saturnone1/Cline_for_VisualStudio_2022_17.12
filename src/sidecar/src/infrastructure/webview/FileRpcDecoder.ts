import type { FileCommand } from "../../features/files/FileRpcHandler"

export function decodeFileRpcCommand(key: string, message: unknown): FileCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "FileService.createRuleFile":
		case "FileService.deleteRuleFile":
		case "FileService.createSkillFile":
		case "FileService.deleteSkillFile":
		case "FileService.openMention":
		case "FileService.openDiskConversationHistory":
		case "FileService.openFocusChainFile":
		case "FileService.openImage": return { type: "noop" }
		case "FileService.openVsClineDiff": return { type: "openDiff", leftPath: readString(request.leftPath) || readString(request.beforePath), rightPath: readString(request.rightPath) || readString(request.afterPath) || readString(request.filePath), title: readString(request.title) }
		case "FileService.revertVsClineChanges": return { type: "revert", request: { files: arrayOfRecords(request.files).map((file) => ({ filePath: readString(file.filePath), beforePath: readString(file.beforePath), action: readString(file.action) || "modified" })) } }
		case "FileService.copyToClipboard": return { type: "copy", text: readString(request.value) || readString(request.text) }
		case "FileService.ifFileExistsRelativePath": return { type: "exists", relativePath: readString(request.value) || readString(request.path) || readString(request.relativePath) }
		case "FileService.getRelativePaths": return { type: "relativePaths" }
		case "FileService.searchFiles":
		case "FileService.searchCommits": return { type: "search" }
		case "FileService.selectFiles": return { type: "select", allowImages: request.value === true || request.allowImages === true }
		case "FileService.openFile":
		case "FileService.openFileRelativePath": return { type: "openFile", filePath: readString(request.filePath) || readString(request.path) || readString(request.value) || readString(request.relativePath), line: optionalNumber(request.line) }
		default: return undefined
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function arrayOfRecords(value: unknown) { return Array.isArray(value) ? value.map(asRecord) : [] }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function optionalNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
