import fs from "node:fs"
import path from "node:path"

export function readInstalledSdkVersion(sidecarRoot?: string) {
	try {
		const rootedPackagePath = sidecarRoot
			? path.join(sidecarRoot, "node_modules", "@cline", "sdk", "package.json")
			: ""
		if (rootedPackagePath && fs.existsSync(rootedPackagePath)) {
			const metadata = JSON.parse(fs.readFileSync(rootedPackagePath, "utf8")) as { name?: string; version?: string }
			if (!metadata.name || metadata.name === "@cline/sdk") return metadata.version || null
		}

		const entryPath = require.resolve("@cline/sdk")
		let directory = path.dirname(entryPath)
		for (;;) {
			const packagePath = path.join(directory, "package.json")
			if (fs.existsSync(packagePath)) {
				const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string; version?: string }
				if (metadata.name === "@cline/sdk") return metadata.version || null
			}
			const parent = path.dirname(directory)
			if (parent === directory) return null
			directory = parent
		}
	} catch {
		return null
	}
}
