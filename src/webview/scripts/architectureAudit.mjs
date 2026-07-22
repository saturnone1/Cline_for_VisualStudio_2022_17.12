import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const limits = new Map([
	["src/components/settings/utils/providerUtils.ts", 30],
	["src/i18n/index.ts", 100],
	["src/components/clineRules/ClineRulesToggleModal.tsx", 300],
	["src/components/worktrees/WorktreesView.tsx", 450],
])
const requiredModules = [
	"src/components/settings/utils/providerConfigurationNormalizer.ts",
	"src/components/settings/utils/providerConnectionInfo.ts",
	"src/components/settings/utils/providerModeConfiguration.ts",
	"src/components/settings/utils/providerModelCatalog.ts",
	"src/i18n/translations/en.ts",
	"src/i18n/translations/ko.ts",
	"src/components/clineRules/ClineRulesModalContent.tsx",
	"src/components/clineRules/useClineRulesToggleModalController.ts",
	"src/components/worktrees/WorktreeOperationDialogs.tsx",
	"src/components/worktrees/useWorktreesViewController.ts",
]

const violations = []
for (const [relativePath, maximumLines] of limits) {
	const source = fs.readFileSync(path.join(root, relativePath), "utf8")
	const lineCount = source.split(/\r?\n/).length
	if (lineCount > maximumLines) {
		violations.push(`${relativePath} must remain a thin facade (${maximumLines} lines maximum; found ${lineCount}).`)
	}
}
for (const relativePath of requiredModules) {
	if (!fs.existsSync(path.join(root, relativePath))) {
		violations.push(`${relativePath} is required by the WebView ownership boundaries.`)
	}
}

const sourceRoot = path.join(root, "src")
const sourceFiles = collectSourceFiles(sourceRoot)
const sourceSet = new Set(sourceFiles)
const importGraph = new Map()
for (const filePath of sourceFiles) {
	const source = fs.readFileSync(filePath, "utf8")
	const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const dependencies = []
	for (const statement of parsed.statements) {
		if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
		const specifier = statement.moduleSpecifier.text
		validateOwnedBoundary(filePath, specifier)
		const resolved = resolveSourceImport(path.dirname(filePath), specifier, sourceSet)
		if (resolved) dependencies.push(resolved)
	}
	importGraph.set(filePath, dependencies)
}

for (const cycle of findCycles(importGraph)) {
	violations.push(`WebView source dependency cycle: ${cycle.map((entry) => path.relative(root, entry).replaceAll("\\", "/")).join(" -> ")}`)
}

if (violations.length > 0) {
	console.error(violations.join("\n"))
	process.exit(1)
}

console.log("WebView architecture audit passed.")

function collectSourceFiles(directory) {
	const files = []
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(absolute))
		} else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test|stories)\.(ts|tsx)$/.test(entry.name) && !absolute.includes(`${path.sep}generated${path.sep}`)) {
			files.push(absolute)
		}
	}
	return files
}

function resolveSourceImport(directory, specifier, sourceSet) {
	const aliases = [
		["@/", sourceRoot],
		["@components/", path.join(sourceRoot, "components")],
		["@context/", path.join(sourceRoot, "context")],
		["@utils/", path.join(sourceRoot, "utils")],
	]
	const alias = aliases.find(([prefix]) => specifier.startsWith(prefix))
	if (!specifier.startsWith(".") && !alias) return null
	const candidate = alias
		? path.join(alias[1], specifier.slice(alias[0].length))
		: path.resolve(directory, specifier)
	for (const resolved of [`${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, "index.ts"), path.join(candidate, "index.tsx")]) {
		if (sourceSet.has(resolved)) return resolved
	}
	return null
}

function validateOwnedBoundary(filePath, specifier) {
	const relative = path.relative(sourceRoot, filePath).replaceAll("\\", "/")
	if (relative.startsWith("services/") && /(^|\/)components\//.test(specifier)) {
		violations.push(`${relative} must not depend on UI components (${specifier}).`)
	}
	if (relative.startsWith("config/platform") && /(^|\/)(components|context)\//.test(specifier)) {
		violations.push(`${relative} must not depend on runtime UI state (${specifier}).`)
	}
	if (relative === "components/history/HistoryView.tsx" && specifier.includes("services/grpcClient")) {
		violations.push("HistoryView rendering must use its feature controller instead of owning RPC concurrency.")
	}
}

function findCycles(graph) {
	const cycles = []
	const visited = new Set()
	const active = new Set()
	const stack = []
	const signatures = new Set()
	const visit = (node) => {
		if (active.has(node)) {
			const start = stack.indexOf(node)
			const cycle = [...stack.slice(start), node]
			const signature = [...new Set(cycle)].sort().join("|")
			if (!signatures.has(signature)) {
				signatures.add(signature)
				cycles.push(cycle)
			}
			return
		}
		if (visited.has(node)) return
		visited.add(node)
		active.add(node)
		stack.push(node)
		for (const dependency of graph.get(node) || []) visit(dependency)
		stack.pop()
		active.delete(node)
	}
	for (const node of graph.keys()) visit(node)
	return cycles
}
