import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function getSettingsPath() {
	return path.join(getSettingsRoot(), "settings.json")
}

export function getSettingsRoot() {
	const configured = process.env.VSCLINE_SETTINGS_DIR
	if (isUsableDirectory(configured)) {
		return path.resolve(configured)
	}

	const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
	if (isUsableDirectory(localAppData)) {
		return path.join(path.resolve(localAppData), "VsClineAgent")
	}

	const home = getUsableHomeDirectory()
	return path.join(home, "AppData", "Local", "VsClineAgent")
}

export function getUsableHomeDirectory() {
	const candidates = [process.env.USERPROFILE, process.env.HOME, os.homedir(), getFallbackHomeDirectory()]
	for (const candidate of candidates) {
		if (isUsableDirectory(candidate)) {
			return path.resolve(candidate)
		}
	}
	return getFallbackHomeDirectory()
}

export function getFallbackHomeDirectory() {
	const root = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir()
	const fallbackHome = path.join(root, "VsClineAgent", "home")
	try {
		fs.mkdirSync(fallbackHome, { recursive: true })
		return fallbackHome
	} catch {
		return os.tmpdir()
	}
}

export function isUsableDirectory(value: string | undefined): value is string {
	if (!value || value.trim().length === 0 || hasLiteralTildeSegment(value)) {
		return false
	}

	try {
		const resolved = path.resolve(value)
		fs.mkdirSync(resolved, { recursive: true })
		fs.accessSync(resolved, fs.constants.W_OK)
		return true
	} catch {
		return false
	}
}

export function hasLiteralTildeSegment(value: string) {
	return value.split(/[\\/]+/).some((part) => part === "~")
}

export function getSidecarDataPath(fileName: string) {
	return path.join(path.dirname(getSettingsPath()), fileName)
}

export function getScheduledAgentsDirectory(workspaceRoot: string) {
	return workspaceRoot ? path.join(workspaceRoot, ".cline", "cron") : ""
}

export function readScheduledAgentSpecs(workspaceRoot: string) {
	const directory = getScheduledAgentsDirectory(workspaceRoot)
	return safeReadDirFiles(directory)
		.filter((filePath) => [".json", ".md", ".yaml", ".yml"].includes(path.extname(filePath).toLowerCase()))
		.map((filePath) => scheduledSpecFromFile(filePath, workspaceRoot))
		.filter((spec) => Boolean(spec))
		.map((spec) => asRecord(spec))
}

export function scheduledSpecFromFile(filePath: string, workspaceRoot: string) {
	try {
		const raw = fs.readFileSync(filePath, "utf8")
		const extension = path.extname(filePath).toLowerCase()
		const parsed = extension === ".json" ? asRecord(tryParseJson(raw) ?? {}) : parseLooseKeyValueSpec(raw)
		const id = getString(parsed, "id") || path.basename(filePath, extension)
		const prompt = getString(parsed, "prompt") || getString(parsed, "task") || markdownBodyAfterFrontMatter(raw)
		return {
			id,
			name: getString(parsed, "name") || id,
			description: getString(parsed, "description"),
			schedule: getString(parsed, "schedule") || getString(parsed, "cron"),
			prompt,
			enabled: parsed.enabled !== false,
			source: "local",
			workspaceRoot,
			filePath,
			fileName: path.basename(filePath),
			updatedAt: fs.statSync(filePath).mtimeMs,
		}
	} catch {
		return null
	}
}

export function writeScheduledAgentSpec(workspaceRoot: string, request: Record<string, unknown>) {
	const directory = getScheduledAgentsDirectory(workspaceRoot)
	fs.mkdirSync(directory, { recursive: true })
	const specId = safeFileStem(getScheduledSpecId(request) || "scheduled-agent")
	const filePath = path.join(directory, `${specId}.json`)
	const existing = fs.existsSync(filePath) ? asRecord(tryParseJson(fs.readFileSync(filePath, "utf8")) ?? {}) : {}
	const spec = {
		...existing,
		id: specId,
		name: getString(request, "name") || getString(existing, "name") || specId,
		description: getString(request, "description") || getString(existing, "description"),
		schedule: getString(request, "schedule") || getString(request, "cron") || getString(existing, "schedule"),
		prompt: getString(request, "prompt") || getString(request, "task") || getString(request, "text") || getString(existing, "prompt"),
		enabled: request.enabled === undefined ? existing.enabled !== false : request.enabled !== false,
		updatedAt: new Date().toISOString(),
	}
	fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), "utf8")
	return scheduledSpecFromFile(filePath, workspaceRoot) || { ...spec, filePath }
}

export function deleteScheduledAgentSpecFile(workspaceRoot: string, specId: string) {
	const directory = getScheduledAgentsDirectory(workspaceRoot)
	const filePath = path.resolve(directory, `${safeFileStem(specId)}.json`)
	if (!filePath.toLowerCase().startsWith(path.resolve(directory).toLowerCase() + path.sep)) {
		throw new Error("Scheduled agent spec path must stay inside .cline/cron.")
	}
	if (!fs.existsSync(filePath)) {
		return false
	}
	fs.rmSync(filePath, { force: true })
	return true
}

export function getScheduledSpecId(request: Record<string, unknown>) {
	return safeFileStem(getString(request, "id") || getString(request, "specId") || getString(request, "name") || getString(request, "fileName"))
}

export function readScheduledAgentRuns() {
	try {
		const value = tryParseJson(fs.readFileSync(getSidecarDataPath("scheduled-runs.json"), "utf8"))
		return Array.isArray(value) ? value.map(asRecord).slice(0, 25) : []
	} catch {
		return []
	}
}

export function appendScheduledAgentRun(run: Record<string, unknown>) {
	const entry = { runId: `scheduled-${createId()}`, ...run }
	const runs = [entry, ...readScheduledAgentRuns()].slice(0, 25)
	fs.mkdirSync(path.dirname(getSidecarDataPath("scheduled-runs.json")), { recursive: true })
	fs.writeFileSync(getSidecarDataPath("scheduled-runs.json"), JSON.stringify(runs, null, 2), "utf8")
	return entry
}

export function discoverLocalPlugins(workspaceRoot: string) {
	const candidates = [
		workspaceRoot ? path.join(workspaceRoot, ".cline", "plugins") : "",
		workspaceRoot ? path.join(workspaceRoot, ".cline", "plugins.json") : "",
		path.join(path.dirname(getSettingsPath()), "plugins"),
		path.join(getUsableHomeDirectory(), ".cline", "plugins"),
	].filter(Boolean)
	const plugins: Record<string, unknown>[] = []
	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) {
				continue
			}
			const stat = fs.statSync(candidate)
			if (stat.isFile()) {
				plugins.push(...pluginsFromConfigFile(candidate))
			} else if (stat.isDirectory()) {
				for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
					const pluginRoot = path.join(candidate, entry.name)
					const manifest = entry.isDirectory() ? path.join(pluginRoot, ".codex-plugin", "plugin.json") : pluginRoot
					if (entry.isDirectory() && fs.existsSync(manifest)) {
						plugins.push(pluginFromManifest(manifest, pluginRoot))
					}
				}
			}
		} catch {
			plugins.push({ path: candidate, status: "error", local: true })
		}
	}
	return plugins
}

export function pluginsFromConfigFile(filePath: string) {
	const parsed = tryParseJson(fs.readFileSync(filePath, "utf8"))
	const configured = asRecord(parsed).plugins
	const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(configured) ? configured : []
	return list.map((item) => {
		const record = asRecord(item)
		return {
			id: getString(record, "id") || getString(record, "name") || getString(record, "path"),
			name: getString(record, "name") || getString(record, "id"),
			path: getString(record, "path"),
			enabled: record.enabled !== false,
			source: filePath,
			local: true,
			status: "configured",
		}
	})
}

export function pluginFromManifest(manifestPath: string, pluginRoot: string) {
	const manifest = asRecord(tryParseJson(fs.readFileSync(manifestPath, "utf8")) ?? {})
	return {
		id: getString(manifest, "id") || path.basename(pluginRoot),
		name: getString(manifest, "name") || getString(manifest, "id") || path.basename(pluginRoot),
		version: getString(manifest, "version"),
		description: getString(manifest, "description"),
		path: pluginRoot,
		manifestPath,
		enabled: manifest.enabled !== false,
		local: true,
		status: "discovered",
	}
}

export function parseLooseKeyValueSpec(text: string) {
	const result: Record<string, unknown> = {}
	const frontMatter = text.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/)
	const source = frontMatter?.[1] || text
	for (const line of source.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/)
		if (match) {
			result[match[1]] = match[2].replace(/^["']|["']$/g, "")
		}
	}
	return result
}

export function markdownBodyAfterFrontMatter(text: string) {
	return text.replace(/^---\s*[\r\n]+[\s\S]*?[\r\n]+---\s*/, "").trim()
}

export function safeFileStem(value: string) {
	return String(value || "")
		.trim()
		.replace(/\.[^.]+$/, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function getString(record: Record<string, unknown>, key: string) {
	const value = record[key]
	return typeof value === "string" ? value : value == null ? "" : String(value)
}
function tryParseJson(value: string) {
	try { return JSON.parse(value) as unknown } catch { return undefined }
}
function createId() {
	return [Date.now(), Math.random().toString(16).slice(2)].join("-")
}
function safeReadDirFiles(directory: string) {
	try { return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name)) } catch { return [] }
}
