import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const webviewRoot = path.resolve(scriptDirectory, "..")
const repositoryRoot = path.resolve(webviewRoot, "..", "..")
const outputRoot = path.join(repositoryRoot, "artifacts", "WebApp")
const manifestPath = path.join(outputRoot, "build-manifest.json")

const sourceEntries = [
	"index.html",
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.app.json",
	"tsconfig.node.json",
	"vite.config.ts",
	"src",
	"scripts",
]

function filesUnder(root, entries, excluded = new Set()) {
	const files = []
	const visit = (entryPath) => {
		if (!fs.existsSync(entryPath)) return
		const stat = fs.statSync(entryPath)
		if (stat.isDirectory()) {
			for (const child of fs.readdirSync(entryPath).sort()) visit(path.join(entryPath, child))
			return
		}
		if (!excluded.has(path.resolve(entryPath))) files.push(entryPath)
	}
	for (const entry of entries) visit(path.join(root, entry))
	return files
}

function hashFiles(root, files) {
	const hash = crypto.createHash("sha256")
	for (const filePath of files.sort()) {
		hash.update(path.relative(root, filePath).replaceAll("\\", "/"))
		hash.update("\0")
		const contents = fs.readFileSync(filePath)
		const extension = path.extname(filePath).toLowerCase()
		const normalized = [".css", ".html", ".js", ".json", ".mjs", ".ts", ".tsx"].includes(extension)
			? contents.toString("utf8").replaceAll("\r\n", "\n")
			: contents
		hash.update(normalized)
		hash.update("\0")
	}
	return hash.digest("hex")
}

function snapshot() {
	const sourceFiles = filesUnder(webviewRoot, sourceEntries, new Set([path.resolve(manifestPath)]))
	const outputFiles = filesUnder(outputRoot, ["."], new Set([path.resolve(manifestPath)]))
	return {
		version: 2,
		sourceHash: hashFiles(webviewRoot, sourceFiles),
		outputHash: hashFiles(outputRoot, outputFiles),
		sourceFileCount: sourceFiles.length,
		outputFileCount: outputFiles.length,
		outputFiles: outputFiles.map((filePath) => path.relative(repositoryRoot, filePath).replaceAll("\\", "/")),
	}
}

function assertOutputFilesTracked(outputFiles) {
	const tracked = new Set(execFileSync("git", ["ls-files", "-z", "--", "artifacts/WebApp"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).split("\0").filter(Boolean).map((filePath) => filePath.replaceAll("\\", "/")))
	const expected = [...outputFiles, "artifacts/WebApp/build-manifest.json"]
	const missing = expected.filter((filePath) => !tracked.has(filePath))
	if (missing.length > 0) {
		throw new Error(`Generated WebApp files are not tracked:\n${missing.map((filePath) => `- ${filePath}`).join("\n")}`)
	}
}

const current = snapshot()
if (process.argv.includes("--check")) {
	if (!fs.existsSync(manifestPath)) throw new Error("WebApp build manifest is missing. Run npm run build in src/webview.")
	const recorded = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
	for (const field of ["version", "sourceHash", "outputHash", "sourceFileCount", "outputFileCount"]) {
		if (recorded[field] !== current[field]) {
			throw new Error(`WebApp snapshot is stale: ${field} differs. Run npm run build in src/webview.`)
		}
	}
	if (JSON.stringify(recorded.outputFiles) !== JSON.stringify(current.outputFiles)) {
		throw new Error("WebApp snapshot is stale: outputFiles differs. Run npm run build in src/webview.")
	}
	if (process.argv.includes("--require-tracked")) assertOutputFilesTracked(current.outputFiles)
	console.log("WebApp source/output snapshot check passed.")
} else {
	fs.mkdirSync(outputRoot, { recursive: true })
	fs.writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`, "utf8")
	console.log("WebApp build manifest updated.")
}
