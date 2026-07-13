import fs from "node:fs"
import path from "node:path"

type ClineSdkModule = typeof import("@cline/sdk")

export type ClineSdkMcpSettings = {
	mcpServers: Record<string, Record<string, unknown>>
}

export class ClineSdkMcpSettingsStore {
	private settingsPath: string | null = null
	private mutationQueue: Promise<void> = Promise.resolve()

	resolvePath(sdk: ClineSdkModule) {
		if (!this.settingsPath) {
			this.settingsPath = sdk.resolveDefaultMcpSettingsPath()
		}
		this.ensureFile(this.settingsPath)
		return this.settingsPath
	}

	load(sdk: ClineSdkModule): ClineSdkMcpSettings {
		const filePath = this.resolvePath(sdk)
		const settings = sdk.loadMcpSettingsFile({ filePath }) as ClineSdkMcpSettings
		settings.mcpServers = asRecord(settings.mcpServers) as Record<string, Record<string, unknown>>
		return settings
	}

	async mutate(sdk: ClineSdkModule, mutate: (settings: ClineSdkMcpSettings) => void | Promise<void>) {
		const operation = this.mutationQueue.then(async () => {
			const settings = this.load(sdk)
			await mutate(settings)
			await this.save(sdk, settings)
		})
		this.mutationQueue = operation.catch(() => undefined)
		await operation
	}

	ensureFile(filePath: string) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf8")
			if (isValidJsonObject(content)) {
				return
			}

			const backupPath = `${filePath}.bak`
			const backup = fs.existsSync(backupPath) ? fs.readFileSync(backupPath, "utf8") : ""
			if (isValidJsonObject(backup)) {
				writeFileAtomicSync(filePath, backup)
				return
			}

			if (content.trim()) {
				fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
			}
		}
		writeFileAtomicSync(filePath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`)
	}

	private async save(sdk: ClineSdkModule, settings: ClineSdkMcpSettings) {
		const filePath = this.resolvePath(sdk)
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
		const content = `${JSON.stringify({ mcpServers: settings.mcpServers || {} }, null, 2)}\n`
		const previous = await fs.promises.readFile(filePath, "utf8").catch(() => "")
		if (isValidJsonObject(previous)) {
			await writeFileAtomic(`${filePath}.bak`, previous)
		}
		await writeFileAtomic(filePath, content)
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isValidJsonObject(content: string) {
	if (!content.trim()) return false
	try {
		const parsed = JSON.parse(content)
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
	} catch {
		return false
	}
}

async function writeFileAtomic(filePath: string, content: string) {
	const tempPath = createTempPath(filePath)
	try {
		await fs.promises.writeFile(tempPath, content, "utf8")
		await fs.promises.rename(tempPath, filePath)
	} finally {
		await fs.promises.unlink(tempPath).catch(() => undefined)
	}
}

function writeFileAtomicSync(filePath: string, content: string) {
	const tempPath = createTempPath(filePath)
	try {
		fs.writeFileSync(tempPath, content, "utf8")
		fs.renameSync(tempPath, filePath)
	} finally {
		if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
	}
}

function createTempPath(filePath: string) {
	return `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
}
