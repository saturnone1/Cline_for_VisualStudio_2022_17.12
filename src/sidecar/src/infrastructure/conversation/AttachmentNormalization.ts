import fs from "node:fs"
import path from "node:path"

export function buildTaskInputWithAttachments(text: string, images: string[], files: string[]) {
	const attachments = [
		...images.map((image) => `Image: ${formatAttachmentSummaryValue(image)}`),
		...files.map((file) => `File: ${file}`),
	]
	return attachments.length > 0 ? `${text}\n\nAttachments:\n${attachments.join("\n")}` : text
}

export async function normalizeSdkImageInputs(images: string[]) {
	return (await Promise.all(images.map((image) => normalizeSdkImageInput(image)))).filter(Boolean)
}

export async function normalizeSdkImageInput(image: string) {
	const trimmed = image.trim()
	if (!trimmed) return ""
	if (/^(https?:|data:image\/)/i.test(trimmed)) return trimmed
	return tryCreateImageDataUri(trimmed.startsWith("file://") ? fileUrlToPath(trimmed) : trimmed)
}

export function fileUrlToPath(value: string) {
	try {
		return decodeURIComponent(value.replace(/^file:\/\/\/?/i, "")).replace(/\//g, path.sep)
	} catch {
		return value
	}
}

export async function tryCreateImageDataUri(filePath: string) {
	try {
		if (!filePath || !(await fs.promises.stat(filePath)).isFile()) return ""
		const mimeType = getImageMimeType(filePath)
		if (!mimeType) return ""
		return `data:${mimeType};base64,${(await fs.promises.readFile(filePath)).toString("base64")}`
	} catch {
		return ""
	}
}

export function getImageMimeType(filePath: string) {
	switch (path.extname(filePath).toLowerCase()) {
		case ".png": return "image/png"
		case ".jpg":
		case ".jpeg": return "image/jpeg"
		case ".gif": return "image/gif"
		case ".webp": return "image/webp"
		case ".bmp": return "image/bmp"
		default: return ""
	}
}

export function formatAttachmentSummaryValue(value: string) {
	if (!value.toLowerCase().startsWith("data:image/")) return value
	const separatorIndex = value.toLowerCase().indexOf(";base64,")
	const mimeType = separatorIndex > "data:".length ? value.slice("data:".length, separatorIndex) : "image"
	return `[attached ${mimeType}]`
}
