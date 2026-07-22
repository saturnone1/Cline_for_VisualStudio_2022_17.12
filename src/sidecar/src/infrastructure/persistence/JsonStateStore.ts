import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { StateStorePort } from "../../application/ports/StateStorePort"

export class JsonStateStore implements StateStorePort {
	private revision = 0
	private generation = Date.now()

	constructor(private readonly filePath: string) {}

	static createDefault() {
		return new JsonStateStore(resolveDefaultStatePath())
	}

	load() {
		const candidates = [
			pairSnapshots(readSnapshot(this.filePath), readSnapshot(this.transcriptPath), false),
			pairSnapshots(readSnapshot(this.backupPath), readSnapshot(this.transcriptBackupPath), true),
		].filter((value): value is SnapshotPair => Boolean(value))
		const selected = candidates.sort((left, right) => right.generation - left.generation)[0]
		if (!selected) return null
		this.generation = Math.max(this.generation, selected.generation)
		if (selected.fromBackup) {
			console.warn(`Recovered LIG VS settings from backup: ${this.backupPath}`)
			this.save(selected.snapshot)
		}
		return selected.snapshot
	}

	save(snapshot: Record<string, unknown>) {
		const revision = ++this.revision
		const generation = ++this.generation
		const { settings, transcripts } = splitStateSnapshot(snapshot, generation)
		try {
			backupCurrentPair(this.filePath, this.transcriptPath, this.backupPath, this.transcriptBackupPath)
			writeAtomicJson(this.transcriptPath, transcripts)
			writeAtomicJson(this.filePath, settings)
		} catch (error) {
			console.error("Failed to persist LIG VS settings:", error)
			throw error
		}
		return revision
	}

	async saveDeferred(snapshot: Record<string, unknown>) {
		const revision = ++this.revision
		const generation = ++this.generation
		const { settings, transcripts } = splitStateSnapshot(snapshot, generation)
		const settingsTemporaryPath = temporaryPath(this.filePath, revision)
		const transcriptTemporaryPath = temporaryPath(this.transcriptPath, revision)
		try {
			await Promise.all([
				writeTemporaryJson(settingsTemporaryPath, settings),
				writeTemporaryJson(transcriptTemporaryPath, transcripts),
			])
			if (revision !== this.revision) return
			backupCurrentPair(this.filePath, this.transcriptPath, this.backupPath, this.transcriptBackupPath)
			fs.renameSync(transcriptTemporaryPath, this.transcriptPath)
			fs.renameSync(settingsTemporaryPath, this.filePath)
		} finally {
			try { fs.rmSync(settingsTemporaryPath, { force: true }) } catch { }
			try { fs.rmSync(transcriptTemporaryPath, { force: true }) } catch { }
		}
	}

	invalidatePendingWrites() {
		this.revision++
	}

	clear() {
		this.invalidatePendingWrites()
		const failures: string[] = []
		for (const filePath of [this.filePath, this.backupPath, this.transcriptPath, this.transcriptBackupPath]) {
			try { fs.rmSync(filePath, { force: true }) }
			catch (error) { failures.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`) }
		}
		if (failures.length > 0) throw new Error(`Failed to clear persisted LIG VS state:\n${failures.join("\n")}`)
	}

	private get backupPath() {
		return `${this.filePath}.bak`
	}

	private get transcriptPath() { return path.join(path.dirname(this.filePath), "transcripts.json") }
	private get transcriptBackupPath() { return `${this.transcriptPath}.bak` }
}

const TRANSCRIPT_KEYS = ["taskSnapshots", "currentTaskItem", "clineMessages"] as const
const MAX_SNAPSHOTS = 50
const MAX_MESSAGES_PER_SNAPSHOT = 300
const MAX_CURRENT_MESSAGES = 600
const MAX_MESSAGE_TEXT_CHARS = 64 * 1024

const GENERATION_KEY = "__ligVsStateGeneration"
type SnapshotPair = { snapshot: Record<string, unknown>; generation: number; fromBackup: boolean }

function splitStateSnapshot(snapshot: Record<string, unknown>, generation: number) {
	const settings: Record<string, unknown> = { ...snapshot, [GENERATION_KEY]: generation }
	const transcripts: Record<string, unknown> = { [GENERATION_KEY]: generation }
	for (const key of TRANSCRIPT_KEYS) if (key in settings) { transcripts[key] = settings[key]; delete settings[key] }
	if ("clineMessages" in transcripts) transcripts.clineMessages = boundMessages(transcripts.clineMessages, MAX_CURRENT_MESSAGES)
	if ("taskSnapshots" in transcripts) transcripts.taskSnapshots = boundSnapshots(transcripts.taskSnapshots, snapshot.taskHistory, String(asRecord(snapshot.currentTaskItem).id || ""))
	return { settings, transcripts }
}

function pairSnapshots(settings: Record<string, unknown> | null, transcripts: Record<string, unknown> | null, fromBackup: boolean): SnapshotPair | null {
	if (!settings) return null
	const settingsGeneration = generationOf(settings)
	const transcriptGeneration = generationOf(transcripts)
	if (settingsGeneration > 0 && settingsGeneration !== transcriptGeneration) return null
	const snapshot = { ...settings, ...(transcripts || {}) }
	delete snapshot[GENERATION_KEY]
	return { snapshot, generation: settingsGeneration, fromBackup }
}

function boundSnapshots(value: unknown, historyValue: unknown, currentTaskId: string) {
	const snapshots = asRecord(value)
	const history = Array.isArray(historyValue) ? historyValue.map(asRecord) : []
	const priorityIds = history
		.sort((left, right) => Number(right.ts || 0) - Number(left.ts || 0))
		.sort((left, right) => Number(right.isFavorited === true) - Number(left.isFavorited === true))
		.map((item) => String(item.id || ""))
		.filter(Boolean)
	if (currentTaskId) priorityIds.unshift(currentTaskId)
	for (const id of Object.keys(snapshots)) if (!priorityIds.includes(id)) priorityIds.push(id)
	const bounded: Record<string, unknown> = {}
	for (const id of [...new Set(priorityIds)].slice(0, MAX_SNAPSHOTS)) {
		const snapshot = asRecord(snapshots[id])
		if (Object.keys(snapshot).length) bounded[id] = { ...snapshot, messages: boundMessages(snapshot.messages, MAX_MESSAGES_PER_SNAPSHOT) }
	}
	return bounded
}

function boundMessages(value: unknown, limit: number) {
	if (!Array.isArray(value)) return []
	const selected = selectMessagesForPersistence(value, limit)
	return selected.map((item) => {
		const message = { ...asRecord(item) }
		for (const key of ["text", "reasoning"] as const) if (typeof message[key] === "string" && message[key].length > MAX_MESSAGE_TEXT_CHARS) message[key] = `${message[key].slice(0, MAX_MESSAGE_TEXT_CHARS)}\n[truncated in local transcript cache]`
		if (Array.isArray(message.images)) message.images = message.images.slice(0, 4).map((image) => typeof image === "string" && image.startsWith("data:") ? "[image omitted from local transcript cache]" : image)
		return message
	})
}

function selectMessagesForPersistence(messages: unknown[], limit: number) {
	if (messages.length <= limit) return messages
	const anchorIndexes = new Set<number>([0])
	for (let index = messages.length - 1; index >= 0; index--) {
		if (asRecord(messages[index]).contextCompaction) {
			anchorIndexes.add(index)
			break
		}
	}
	const selectedIndexes = new Set<number>(anchorIndexes)
	for (let index = messages.length - 1; index >= 0 && selectedIndexes.size < limit; index--) selectedIndexes.add(index)
	return [...selectedIndexes].sort((left, right) => left - right).map((index) => messages[index])
}

function writeAtomicJson(filePath: string, value: Record<string, unknown>) {
	const temporaryPath = `${filePath}.${process.pid}.tmp`
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8")
		flushFile(temporaryPath)
		fs.renameSync(temporaryPath, filePath)
	} finally {
		try { fs.rmSync(temporaryPath, { force: true }) } catch { }
	}
}

async function writeTemporaryJson(filePath: string, value: Record<string, unknown>) {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
	const handle = await fs.promises.open(filePath, "w")
	try {
		await handle.writeFile(JSON.stringify(value), "utf8")
		await handle.sync()
	} finally {
		await handle.close()
	}
}

function temporaryPath(filePath: string, revision: number) { return `${filePath}.${process.pid}.${revision}.tmp` }
function generationOf(value: Record<string, unknown> | null) { const generation = value?.[GENERATION_KEY]; return typeof generation === "number" && Number.isFinite(generation) ? generation : 0 }
function backupCurrentPair(settingsPath: string, transcriptPath: string, settingsBackupPath: string, transcriptBackupPath: string) {
	if (readSnapshot(settingsPath) && readSnapshot(transcriptPath)) {
		fs.copyFileSync(settingsPath, settingsBackupPath)
		fs.copyFileSync(transcriptPath, transcriptBackupPath)
	}
}

function asRecord(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

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
