import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function resolveWorkspacePath(inputPath: string, workspaceRoots: string[], basePath?: string) {
	if (!inputPath || inputPath.trim().length === 0) throw new Error("Path is required.")
	const roots = workspaceRoots.map((root) => path.resolve(root))
	const base = basePath && basePath.trim().length > 0 ? path.resolve(basePath) : roots[0]
	const normalizedInputPath = expandTildePath(inputPath)
	const resolved = path.resolve(path.isAbsolute(normalizedInputPath) ? normalizedInputPath : path.join(base || process.cwd(), normalizedInputPath))
	if (!roots.some((root) => isPathInsideOrEqual(resolved, root))) {
		throw new Error(`Access denied: path outside Visual Studio workspace: ${inputPath}`)
	}
	return resolved
}

export function ensureUsableHomeEnvironment() {
	const fallbackHome = getFallbackHomeDirectory()
	for (const name of ["HOME", "USERPROFILE"]) {
		if (!isUsableHomePath(process.env[name])) process.env[name] = fallbackHome
	}
}

export function getLocalAppDataRoot() {
	return process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd()
}

export function sanitizePathPart(value: string) {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "item"
}

function expandTildePath(inputPath: string) {
	const trimmed = inputPath.trim()
	return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
		? path.join(getUsableHomeDirectory(), trimmed.slice(1))
		: inputPath
}

function getUsableHomeDirectory() {
	for (const candidate of [process.env.USERPROFILE, process.env.HOME, os.homedir(), getFallbackHomeDirectory()]) {
		if (candidate && isUsableHomePath(candidate)) return path.resolve(candidate)
	}
	return getFallbackHomeDirectory()
}

function getFallbackHomeDirectory() {
	const root = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.tmpdir(), "VsClineAgent")
	const fallbackHome = path.join(root, "VsClineAgent", "home")
	try {
		fs.mkdirSync(fallbackHome, { recursive: true })
		return fallbackHome
	} catch {
		return process.cwd()
	}
}

function isUsableHomePath(value: string | undefined) {
	if (!value || value.trim().length === 0 || value.split(/[\\/]+/).some((part) => part === "~")) return false
	try {
		const resolved = path.resolve(value)
		fs.mkdirSync(resolved, { recursive: true })
		fs.accessSync(resolved, fs.constants.W_OK)
		return true
	} catch {
		return false
	}
}

function isPathInsideOrEqual(candidate: string, root: string) {
	const relative = path.relative(root, candidate)
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}
