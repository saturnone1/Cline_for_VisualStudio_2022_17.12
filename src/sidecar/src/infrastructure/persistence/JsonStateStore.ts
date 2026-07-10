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
		const primary = readSnapshot(this.filePath)
		if (primary) {
			return primary
		}

		const backup = readSnapshot(this.backupPath)
		if (!backup) {
			return null
		}

		console.warn(`Recovered LIG VS settings from backup: ${this.backupPath}`)
		this.save(backup)
		return backup
	}

	save(snapshot: Record<string, unknown>) {
		const temporaryPath = `${this.filePath}.${process.pid}.tmp`
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
			fs.writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8")
			flushFile(temporaryPath)
			if (readSnapshot(this.filePath)) {
				fs.copyFileSync(this.filePath, this.backupPath)
			}
			fs.renameSync(temporaryPath, this.filePath)
		} catch (error) {
			console.error("Failed to persist LIG VS settings:", error)
		} finally {
			try {
				fs.rmSync(temporaryPath, { force: true })
			} catch {
				// A stale temporary file is ignored on the next startup.
			}
		}
	}

	clear() {
		try {
			fs.rmSync(this.filePath, { force: true })
			fs.rmSync(this.backupPath, { force: true })
		} catch {
			// Reset still applies to in-memory state when cleanup is unavailable.
		}
	}

	private get backupPath() {
		return `${this.filePath}.bak`
	}
}

function readSnapshot(filePath: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(fs.readFileSync(filePath, "utf8"))
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
	} catch {
		return null
	}
}

function flushFile(filePath: string) {
	const descriptor = fs.openSync(filePath, "r+")
	try {
		fs.fsyncSync(descriptor)
	} finally {
		fs.closeSync(descriptor)
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
