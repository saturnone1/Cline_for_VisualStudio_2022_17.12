import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

export function writeJsonAtomicSync(filePath: string, value: unknown) {
	const directory = path.dirname(filePath)
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
	fs.mkdirSync(directory, { recursive: true })
	try {
		const handle = fs.openSync(temporaryPath, "wx")
		try {
			fs.writeFileSync(handle, JSON.stringify(value, null, 2), "utf8")
			fs.fsyncSync(handle)
		} finally {
			fs.closeSync(handle)
		}
		fs.renameSync(temporaryPath, filePath)
	} finally {
		try { fs.rmSync(temporaryPath, { force: true }) } catch { }
	}
}
