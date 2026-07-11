import path from "node:path"
import type { WorkspacePort } from "../../application/ports/HostProviderPort"

export type TrackedChangeSummary = { filePath: string; beforePath: string; afterPath: string; action: string; additions: number; deletions: number }

export class ChangeTrackingHandler {
	private readonly recentPaths = new Map<string, number>()
	private readonly pending = new Map<string, TrackedChangeSummary>()
	private timer: NodeJS.Timeout | null = null

	constructor(private readonly workspace: WorkspacePort, private readonly publishTranscript: (text: string) => Promise<void>, private readonly debounceMs = 250, private readonly recentTtlMs = 15_000) {}

	track(payload: Record<string, unknown>) {
		const filePath = readString(payload.filePath), beforePath = readString(payload.beforePath), afterPath = readString(payload.afterPath) || filePath
		if (!filePath || !beforePath || !afterPath) return
		this.recentPaths.set(normalize(filePath), Date.now())
		this.prune()
		this.queue({ filePath, beforePath, afterPath, action: readString(payload.action) || "modified", additions: readNumber(payload.additions) || 0, deletions: readNumber(payload.deletions) || 0 })
	}

	pendingChanges() { return Array.from(this.pending.values()).map((change) => ({ ...change })) }
	wasRecentlyTracked(filePath: string) { this.prune(); return this.recentPaths.has(normalize(filePath)) }
	hasRecentlyTrackedChange() { this.prune(); return this.recentPaths.size > 0 }

	async revert(message: unknown) {
		const request = asRecord(message), files = (Array.isArray(request.files) ? request.files : []).map(asRecord).filter((file) => readString(file.filePath))
		const reverted: string[] = [], skipped: Array<{ filePath: string; reason: string }> = []
		for (const file of files) {
			const filePath = readString(file.filePath), beforePath = readString(file.beforePath), action = readString(file.action) || "modified"
			try {
				if (action === "created") { await this.workspace.deleteFile({ path: filePath }); reverted.push(filePath); continue }
				if (!beforePath) { skipped.push({ filePath, reason: "missing before snapshot" }); continue }
				const before = asRecord(await this.workspace.readTextFile({ path: beforePath }))
				if (before.exists !== true) { skipped.push({ filePath, reason: "before snapshot not found" }); continue }
				await this.workspace.writeTextFile({ path: filePath, content: readString(before.content) }); reverted.push(filePath)
			} catch (error) { skipped.push({ filePath, reason: error instanceof Error ? error.message : String(error) }) }
		}
		const content = skipped.length ? `Reverted ${reverted.length} file${reverted.length === 1 ? "" : "s"}; skipped ${skipped.length}.` : `Reverted ${reverted.length} file${reverted.length === 1 ? "" : "s"}.`
		await this.publishTranscript(JSON.stringify({ tool: "vsclineRevertedFiles", path: reverted[0] || skipped[0]?.filePath || "", content, files: reverted, skipped }))
		return { success: skipped.length === 0, reverted, skipped, message: content }
	}

	dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null }

	private queue(change: TrackedChangeSummary) {
		const key = normalize(change.filePath), existing = this.pending.get(key)
		this.pending.set(key, { ...change, beforePath: existing?.beforePath || change.beforePath, additions: (existing?.additions || 0) + change.additions, deletions: (existing?.deletions || 0) + change.deletions })
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => this.flush().catch(console.error), this.debounceMs)
	}

	private async flush() {
		this.timer = null
		const files = this.pendingChanges(); this.pending.clear()
		if (!files.length) return
		const additions = files.reduce((sum, file) => sum + file.additions, 0), deletions = files.reduce((sum, file) => sum + file.deletions, 0)
		const changed = files.filter((file) => file.action !== "created" && file.action !== "deleted").length, created = files.filter((file) => file.action === "created").length, deleted = files.filter((file) => file.action === "deleted").length
		const actions = [changed ? `edited ${changed}` : "", created ? `created ${created}` : "", deleted ? `deleted ${deleted}` : ""].filter(Boolean)
		await this.publishTranscript(JSON.stringify({ tool: "vsclineChangedFiles", path: files[0]?.filePath || "", content: `LIG VS ${actions.join(", ") || "changed"} file${files.length > 1 ? "s" : ""}.`, files, additions, deletions }))
	}

	private prune() { const cutoff = Date.now() - this.recentTtlMs; for (const [filePath, timestamp] of this.recentPaths) if (timestamp < cutoff) this.recentPaths.delete(filePath) }
}

function normalize(value: string) { try { return path.resolve(value).toLowerCase() } catch { return value.toLowerCase() } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
function readNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : undefined }
