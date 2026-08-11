import fs from "node:fs"
import path from "node:path"

export function samePath(left: string, right: string) {
	if (!left || !right) {
		return false
	}
	return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

export function isPathInside(candidate: string, root: string) {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export async function pathExists(candidate: string) {
	if (!candidate) {
		return false
	}
	try {
		await fs.promises.access(candidate)
		return true
	} catch {
		return false
	}
}

export function findSolutions(root: string) {
	const solutions = new Set<string>()
	const direct = safeReadDir(root)
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sln"))
		.map((entry) => path.join(root, entry.name))
		.sort()
	for (const solution of direct) {
		solutions.add(solution)
	}

	const queue = safeReadDir(root)
		.filter((entry) => entry.isDirectory() && ![".git", "bin", "obj", "node_modules"].includes(entry.name))
		.map((entry) => path.join(root, entry.name))
	while (queue.length > 0) {
		const current = queue.shift()!
		const entries = safeReadDir(current)
		for (const solution of entries
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sln"))
			.map((entry) => path.join(current, entry.name))
			.sort()) {
			solutions.add(solution)
		}
		for (const entry of entries) {
			if (entry.isDirectory() && ![".git", "bin", "obj", "node_modules"].includes(entry.name)) {
				queue.push(path.join(current, entry.name))
			}
		}
	}
	return Array.from(solutions).sort()
}

function safeReadDir(root: string) {
	try {
		return fs.readdirSync(root, { withFileTypes: true })
	} catch {
		return []
	}
}

