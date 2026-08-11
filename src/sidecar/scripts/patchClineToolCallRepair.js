const fs = require("node:fs")
const path = require("node:path")

const marker = "/*lig-vs-tool-name-repair*/"
const compactionMarker = "/*lig-vs-compaction-source*/"

function resolveKnownToolName(requestedName, availableNames) {
	const candidates = availableNames
		.filter((name) => typeof name === "string"
			&& requestedName.startsWith(name)
			&& requestedName.length > name.length
			&& !/[A-Za-z0-9_-]/.test(requestedName.charAt(name.length)))
		.sort((left, right) => right.length - left.length)
	if (candidates.length === 0) return undefined
	if (candidates.length > 1 && candidates[0].length === candidates[1].length) return undefined
	return candidates[0]
}

function patchFile(filePath) {
	const source = fs.readFileSync(filePath, "utf8")
	if (source.includes(marker)) return false
	const repairReference = source.match(/experimental_repairToolCall:([A-Za-z0-9_$]+)/)
	if (!repairReference) return false
	const functionName = repairReference[1]
	const start = source.indexOf(`async function ${functionName}(`)
	const endMarker = start >= 0 ? source.indexOf("}function", start) : -1
	if (start < 0 || endMarker < 0) {
		throw new Error(`Unsupported @cline/llms tool repair implementation: ${filePath}`)
	}
	const end = endMarker + 1
	const original = source.slice(start, end)
	const signature = original.match(/^async function ([A-Za-z0-9_$]+)\(\{toolCall:([A-Za-z0-9_$]+),error:([A-Za-z0-9_$]+)\}\)\{if\(([A-Za-z0-9_$]+)\.isInstance\(\3\)\)return null;/)
	if (!signature) throw new Error(`Unsupported @cline/llms tool repair signature: ${filePath}`)
	const [, name, toolCall, error, noSuchToolError] = signature
	const oldPrefix = `async function ${name}({toolCall:${toolCall},error:${error}}){if(${noSuchToolError}.isInstance(${error}))return null;`
	const newPrefix = `async function ${name}({toolCall:${toolCall},error:${error},tools:__ligTools}){${marker}if(${noSuchToolError}.isInstance(${error})){let __ligNames=(Array.isArray(__ligTools)?__ligTools.map(__ligTool=>__ligTool?.name):Object.keys(__ligTools??{})).filter(__ligName=>typeof __ligName==="string"&&${toolCall}.toolName.startsWith(__ligName)&&${toolCall}.toolName.length>__ligName.length&&!/[A-Za-z0-9_-]/.test(${toolCall}.toolName.charAt(__ligName.length))).sort((__ligLeft,__ligRight)=>__ligRight.length-__ligLeft.length);if(__ligNames.length===0||__ligNames.length>1&&__ligNames[0].length===__ligNames[1].length)return null;return{...${toolCall},toolName:__ligNames[0]}}`
	if (!original.startsWith(oldPrefix)) throw new Error(`Unexpected @cline/llms tool repair prefix: ${filePath}`)
	const replacement = newPrefix + original.slice(oldPrefix.length)
	fs.writeFileSync(filePath, source.slice(0, start) + replacement + source.slice(end))
	return true
}

function patchCoreCompactionPersistence(filePath) {
	let source = fs.readFileSync(filePath, "utf8")
	if (source.includes(compactionMarker)) return false

	const prepareTurn = source.match(/function [A-Za-z0-9_$]+\(([A-Za-z0-9_$]+)\)\{return async\(([A-Za-z0-9_$]+)\)=>\{let [A-Za-z0-9_$]+=\1\.getState\?\.\(\),/)
	if (!prepareTurn) throw new Error(`Unsupported @cline/core compaction prepare-turn implementation: ${filePath}`)
	const [, optionsVariable, contextVariable] = prepareTurn
	const saveStatePattern = new RegExp(`await \\${optionsVariable}\\.saveState\\?\\.\\(([A-Za-z0-9_$]+)\\)`, "g")
	const saveStateCalls = [...source.matchAll(saveStatePattern)]
	if (saveStateCalls.length !== 2) {
		throw new Error(`Expected two @cline/core compaction saveState calls, found ${saveStateCalls.length}: ${filePath}`)
	}
	source = source.replace(saveStatePattern, (_match, stateVariable) =>
		`await ${optionsVariable}.saveState?.(${stateVariable},${contextVariable}.messages)`)

	const staleLogIndex = source.indexOf('"Skipped stale session compaction state"')
	const closureStart = source.lastIndexOf("saveState:async(", staleLogIndex)
	const closureEnd = source.indexOf("}),", staleLogIndex)
	if (staleLogIndex < 0 || closureStart < 0 || closureEnd < 0) {
		throw new Error(`Unsupported @cline/core compaction persistence callback: ${filePath}`)
	}
	let closure = source.slice(closureStart, closureEnd + 2)
	const signature = closure.match(/^saveState:async\(([A-Za-z0-9_$]+)\)=>\{/)
	if (!signature) throw new Error(`Unsupported @cline/core compaction persistence signature: ${filePath}`)
	closure = closure.replace(signature[0], `saveState:async(${signature[1]},__ligSourceMessages)=>{${compactionMarker}`)
	const persistenceCall = /this\.persistActiveSessionCompactionState\(([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\)/
	if (!persistenceCall.test(closure)) throw new Error(`Missing @cline/core active compaction persistence call: ${filePath}`)
	closure = closure.replace(persistenceCall, "this.persistActiveSessionCompactionState($1,$2,__ligSourceMessages)")
	source = source.slice(0, closureStart) + closure + source.slice(closureEnd + 2)
	fs.writeFileSync(filePath, source)
	return true
}

function applyPatch(root = path.resolve(__dirname, "..")) {
	const packageDirectory = path.join(root, "node_modules", "@cline", "llms", "dist")
	const targets = ["index.js", "providers.js"].map((name) => path.join(packageDirectory, name))
	for (const target of targets) patchFile(target)
	patchCoreCompactionPersistence(path.join(root, "node_modules", "@cline", "core", "dist", "index.js"))
}

if (require.main === module) applyPatch()

module.exports = { applyPatch, patchCoreCompactionPersistence, resolveKnownToolName }
