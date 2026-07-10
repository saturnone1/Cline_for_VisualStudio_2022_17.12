import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { StateStorePort } from "../../application/ports/StateStorePort"

export class JsonStateStore implements StateStorePort {
	constructor(private readonly filePath: string) {}

	static createDefault() {
		return new JsonStateStore(resolveDefaultStatePath())
	}

	load() {
		try {
			return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, unknown>
		} catch {
			return null
		}
	}

	save(snapshot: Record<string, unknown>) {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
			fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), "utf8")
		} catch (error) {
			console.error("Failed to persist LIG VS settings:", error)
		}
	}

	clear() {
		try {
			fs.rmSync(this.filePath, { force: true })
		} catch {
			// Reset still applies to in-memory state when cleanup is unavailable.
		}
	}
}

function resolveDefaultStatePath() {
	const configured = process.env.VSCLINE_SETTINGS_DIR
	if (isUsableDirectory(configured)) {
		return path.join(path.resolve(configured), "settings.json")
	}

	const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
	if (isUsableDirectory(localAppData)) {
		return path.join(path.resolve(localAppData), "VsClineAgent", "settings.json")
	}

	const home = [process.env.USERPROFILE, process.env.HOME, os.homedir()].find(isUsableDirectory) || os.tmpdir()
	return path.join(path.resolve(home), "AppData", "Local", "VsClineAgent", "settings.json")
}

function isUsableDirectory(value: string | undefined): value is string {
	if (!value || value.trim().length === 0 || value.split(/[\\/]+/).includes("~")) {
		return false
	}
	try {
		fs.mkdirSync(value, { recursive: true })
		fs.accessSync(value, fs.constants.W_OK)
		return true
	} catch {
		return false
	}
}
