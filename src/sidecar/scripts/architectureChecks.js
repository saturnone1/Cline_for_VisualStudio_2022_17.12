"use strict"

const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const sourceRoot = path.resolve(__dirname, "..", "src")
const layerRules = {
	domain: new Set(["application", "infrastructure", "presentation"]),
	application: new Set(["infrastructure", "presentation"]),
	infrastructure: new Set(["presentation"]),
	presentation: new Set(["infrastructure"]),
}
const violations = []

for (const filePath of walk(sourceRoot)) {
	if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) continue
	const relative = normalize(path.relative(sourceRoot, filePath))
	const sourceLayer = relative.split("/")[0]
	const forbidden = layerRules[sourceLayer]
	if (!forbidden) continue

	const source = fs.readFileSync(filePath, "utf8")
	for (const specifier of importSpecifiers(filePath, source)) {
		if (!specifier.startsWith(".")) {
			if (sourceLayer === "domain") {
				violations.push(`${relative} -> ${specifier} (domain must not depend on runtime packages)`)
			}
			if (sourceLayer === "application" && (specifier.startsWith("node:") || specifier === "@cline/sdk")) {
				violations.push(`${relative} -> ${specifier} (application must depend on a port)`)
			}
			if (sourceLayer === "presentation" && specifier.startsWith("node:")) {
				violations.push(`${relative} -> ${specifier} (presentation must use an application port)`)
			}
			continue
		}
		const target = normalize(path.relative(sourceRoot, path.resolve(path.dirname(filePath), specifier)))
		const targetLayer = target.split("/")[0]
		if (forbidden.has(targetLayer)) {
			violations.push(`${relative} -> ${specifier} (${sourceLayer} must not depend on ${targetLayer})`)
		}
	}
}

const routerPath = path.join(sourceRoot, "infrastructure", "webview", "VisualStudioWebviewBackend.ts")
const router = fs.readFileSync(routerPath, "utf8")
for (const marker of ["HostProviderPort", "ClineRuntimePort", "WebviewTransportPort", "InteractionLoggerPort"]) {
	if (!router.includes(marker)) violations.push(`VisualStudioWebviewBackend is missing application port: ${marker}`)
}
if (router.includes("VisualStudioHostProvider") || router.includes("sendHostRequest(")) {
	violations.push("VisualStudioWebviewBackend must not reference concrete host or transport implementations.")
}

const controllerPath = path.join(sourceRoot, "presentation", "webview", "VisualStudioWebviewController.ts")
const controller = fs.readFileSync(controllerPath, "utf8")
if (controller.split(/\r?\n/).length > 100) {
	violations.push("VisualStudioWebviewController must remain a thin presentation adapter (100 lines maximum).")
}

for (const relativePort of [
	"application/ports/McpRuntimePort.ts",
	"application/ports/StateStorePort.ts",
	"application/ports/TaskSessionRuntimePort.ts",
	"application/ports/WebviewApplicationPort.ts",
]) {
	const port = fs.readFileSync(path.join(sourceRoot, ...relativePort.split("/")), "utf8")
	if (/\bany\b/.test(port)) {
		violations.push(`${relativePort} must use explicit boundary types instead of any.`)
	}
}

for (const requiredFile of [
	"application/useCases/McpUseCase.ts",
	"application/useCases/TaskSessionUseCase.ts",
	"infrastructure/persistence/JsonStateStore.ts",
]) {
	if (!fs.existsSync(path.join(sourceRoot, ...requiredFile.split("/")))) {
		violations.push(`Missing architecture component: ${requiredFile}`)
	}
}

if (violations.length) {
	console.error("Clean Architecture dependency check failed:")
	for (const violation of violations) console.error(`- ${violation}`)
	process.exit(1)
}

console.log("Clean Architecture dependency check passed.")

function walk(directory) {
	const files = []
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name)
		if (entry.isDirectory()) files.push(...walk(fullPath))
		else files.push(fullPath)
	}
	return files
}

function importSpecifiers(filePath, source) {
	const values = []
	const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
	visit(sourceFile)
	return values

	function visit(node) {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			values.push(node.moduleSpecifier.text)
		}
		if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
				values.push(node.arguments[0].text)
			}
		}
		ts.forEachChild(node, visit)
	}
}

function normalize(value) {
	return value.replace(/\\/g, "/")
}
