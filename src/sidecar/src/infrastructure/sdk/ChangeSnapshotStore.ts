import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { RUNTIME_DEFAULTS, readBoundedPositiveIntEnv } from "../configuration/RuntimeEnvironment"
import { getLocalAppDataRoot, sanitizePathPart } from "./SdkEnvironment"

export type ChangeSnapshotRetention = Readonly<{
	maximumAgeMs: number
	maximumFiles: number
	maximumBytes: number
}>

type SnapshotEntry = Readonly<{ filePath: string; modifiedAt: number; size: number }>

const cleanupTimes = new Map<string, number>()
let snapshotSequence = 0

export async function writeChangeSnapshot(filePath: string, content: string, sessionId: string, suffix = "before") {
	const changesRoot = path.join(getLocalAppDataRoot(), "VsClineAgent", "changes")
	const sessionRoot = path.join(changesRoot, sanitizePathPart(sessionId || "session"))
	await pruneIfDue(changesRoot)
	await fs.promises.mkdir(sessionRoot, { recursive: true })

	const sequence = ++snapshotSequence
	const snapshotName = [
		Date.now(),
		process.pid,
		sequence,
		randomUUID(),
		sanitizePathPart(path.basename(filePath) || "file"),
	].join("-")
	const snapshotPath = path.join(sessionRoot, `${snapshotName}.${sanitizePathPart(suffix)}`)
	await fs.promises.writeFile(snapshotPath, content, { encoding: "utf8", flag: "wx" })
	return snapshotPath
}

export async function pruneChangeSnapshots(root: string, policy = readRetentionPolicy(), now = Date.now()) {
	const entries = await collectSnapshotEntries(root)
	const survivors: SnapshotEntry[] = []
	for (const entry of entries) {
		if (now - entry.modifiedAt > policy.maximumAgeMs) {
			await removeFile(entry.filePath)
		} else {
			survivors.push(entry)
		}
	}

	survivors.sort((left, right) => right.modifiedAt - left.modifiedAt || right.filePath.localeCompare(left.filePath))
	let retainedBytes = 0
	for (let index = 0; index < survivors.length; index++) {
		const entry = survivors[index]
		if (index >= policy.maximumFiles || retainedBytes + entry.size > policy.maximumBytes) {
			await removeFile(entry.filePath)
			continue
		}
		retainedBytes += entry.size
	}

	await removeEmptyDirectories(root, root)
}

function readRetentionPolicy(): ChangeSnapshotRetention {
	return {
		maximumAgeMs: readBoundedPositiveIntEnv("VSCLINE_CHANGE_SNAPSHOT_RETENTION_DAYS", RUNTIME_DEFAULTS.changeSnapshotRetentionDays, 1, 365) * 24 * 60 * 60 * 1000,
		maximumFiles: readBoundedPositiveIntEnv("VSCLINE_CHANGE_SNAPSHOT_MAX_FILES", RUNTIME_DEFAULTS.changeSnapshotMaximumFiles, 100, 100_000),
		maximumBytes: readBoundedPositiveIntEnv("VSCLINE_CHANGE_SNAPSHOT_MAX_MIB", RUNTIME_DEFAULTS.changeSnapshotMaximumMiB, 16, 4096) * 1024 * 1024,
	}
}

async function pruneIfDue(root: string) {
	const now = Date.now()
	const intervalMs = readBoundedPositiveIntEnv("VSCLINE_CHANGE_SNAPSHOT_CLEANUP_INTERVAL_MS", RUNTIME_DEFAULTS.changeSnapshotCleanupIntervalMs, 1_000, 24 * 60 * 60 * 1000)
	if (now - (cleanupTimes.get(root) || 0) < intervalMs) return
	cleanupTimes.set(root, now)
	try {
		await pruneChangeSnapshots(root, readRetentionPolicy(), now)
	} catch {
		// Snapshot cleanup is best-effort and must not block an editor operation.
	}
}

async function collectSnapshotEntries(root: string): Promise<SnapshotEntry[]> {
	const entries: SnapshotEntry[] = []
	async function visit(directory: string) {
		let children: fs.Dirent[]
		try {
			children = await fs.promises.readdir(directory, { withFileTypes: true })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
		for (const child of children) {
			const childPath = path.join(directory, child.name)
			if (child.isDirectory()) await visit(childPath)
			else if (child.isFile()) {
				const stat = await fs.promises.stat(childPath)
				entries.push({ filePath: childPath, modifiedAt: stat.mtimeMs, size: stat.size })
			}
		}
	}
	await visit(root)
	return entries
}

async function removeFile(filePath: string) {
	try { await fs.promises.rm(filePath, { force: true }) } catch { }
}

async function removeEmptyDirectories(directory: string, root: string): Promise<void> {
	let children: fs.Dirent[]
	try { children = await fs.promises.readdir(directory, { withFileTypes: true }) } catch { return }
	for (const child of children) {
		if (child.isDirectory()) await removeEmptyDirectories(path.join(directory, child.name), root)
	}
	if (directory === root) return
	try {
		if ((await fs.promises.readdir(directory)).length === 0) await fs.promises.rmdir(directory)
	} catch { }
}
