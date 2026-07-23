import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { FileInteractionPort, RuleFileMutation, SkillFileMutation } from "../../application/ports/FileInteractionPort"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import { getUsableHomeDirectory } from "../persistence/LocalAutomationStore"

const MARKDOWN_TEMPLATE = "# Instructions\n\nAdd instructions here.\n"
const SKILL_TEMPLATE = (name: string) => `---\nname: ${name}\ndescription: Describe when this skill should be used.\n---\n\n# ${name}\n\nAdd skill instructions here.\n`
const clineDirectory = () => path.resolve(process.env.CLINE_DIR?.trim() || path.join(getUsableHomeDirectory(), ".cline"))

export class LocalFileInteractionAdapter implements FileInteractionPort {
	constructor(private readonly host: HostProviderPort) {}

	async createRule(request: RuleFileMutation, workspaceRoot: string) {
		const type = normalizeRuleType(request.type)
		if (type === "agents") throw new Error("AGENTS.md creation is not available from this list. Create it in the workspace root.")
		const filename = safeFileName(request.filename || "rule.md")
		const directory = ruleDirectory(type, request.isGlobal, workspaceRoot)
		const target = path.join(directory, filename)
		await createNewFile(target, MARKDOWN_TEMPLATE)
		await this.host.windowClient.openFile({ filePath: target })
		return target
	}

	async deleteRule(request: RuleFileMutation, workspaceRoot: string) {
		const target = requireAbsolutePath(request.rulePath)
		const isWorkspaceAgentsFile = Boolean(workspaceRoot) && samePath(target, path.join(workspaceRoot, "AGENTS.md"))
		if (!isWorkspaceAgentsFile) assertAllowed(target, allowedRuleRoots(workspaceRoot))
		await fs.rm(target, { force: false })
	}

	async createSkill(request: SkillFileMutation, workspaceRoot: string) {
		const name = safePathSegment(request.skillName || "")
		const base = request.isGlobal ? path.join(clineDirectory(), "skills") : requireWorkspace(workspaceRoot, ".cline", "skills")
		const target = path.join(base, name, "SKILL.md")
		await createNewFile(target, SKILL_TEMPLATE(name))
		await this.host.windowClient.openFile({ filePath: target })
		return target
	}

	async deleteSkill(request: SkillFileMutation, workspaceRoot: string) {
		const target = requireAbsolutePath(request.skillPath)
		assertAllowed(target, allowedSkillRoots(workspaceRoot))
		if (path.basename(target).toLocaleLowerCase() !== "skill.md") throw new Error("Only a SKILL.md entry can be deleted as a skill.")
		await fs.rm(path.dirname(target), { recursive: true, force: false })
	}

	async openMention(value: string, workspaceRoots: readonly string[]) {
		const mention = value.trim().replace(/^@/, "")
		if (/^https?:\/\//i.test(mention)) {
			await this.host.envClient.openExternal({ value: mention })
			return
		}
		if (["terminal", "problems", "git-changes"].includes(mention)) {
			await this.host.windowClient.showMessage({ type: "info", message: `@${mention} is context information and has no file to open.` })
			return
		}
		const filePath = await resolveMentionPath(mention, workspaceRoots)
		if (!filePath) throw new Error(`Could not resolve mention: @${mention}`)
		await this.host.windowClient.openFile({ filePath })
	}

	async openImage(value: string) {
		const image = value.trim()
		if (/^https?:\/\//i.test(image)) {
			await this.host.envClient.openExternal({ value: image })
			return
		}
		const data = decodeImageDataUrl(image)
		const target = data ? await writeTemporaryFile("image", data.extension, data.bytes) : requireAbsolutePath(fileUriToPath(image))
		await this.host.windowClient.openFile({ filePath: target })
	}

	async openConversationHistory(taskId: string, content: string) {
		const target = await writeTemporaryFile(`conversation-${safePathSegment(taskId)}`, ".json", Buffer.from(content, "utf8"))
		await this.host.windowClient.openFile({ filePath: target })
	}

	async openFocusChain(taskId: string, content: string) {
		const target = await writeTemporaryFile(`focus-chain-${safePathSegment(taskId)}`, ".md", Buffer.from(content || "# Focus Chain\n\nNo focus-chain entries are available.\n", "utf8"))
		await this.host.windowClient.openFile({ filePath: target })
	}
}

function normalizeRuleType(value?: string) { return ["workflow", "agents"].includes(value || "") ? value as "workflow" | "agents" : "cline" }
function ruleDirectory(type: "cline" | "workflow" | "agents", global: boolean, root: string) {
	if (global) return path.join(clineDirectory(), type === "workflow" ? "workflows" : "rules")
	return requireWorkspace(root, ".clinerules", ...(type === "workflow" ? ["workflows"] : []))
}
function allowedRuleRoots(root: string) { return [path.join(clineDirectory(), "rules"), path.join(clineDirectory(), "workflows"), ...(root ? [path.join(root, ".clinerules"), path.join(root, ".cursor", "rules"), path.join(root, ".windsurf", "rules"), path.join(root, ".agents", "rules")] : [])] }
function allowedSkillRoots(root: string) { return [path.join(clineDirectory(), "skills"), ...(root ? [path.join(root, ".cline", "skills"), path.join(root, ".clinerules", "skills"), path.join(root, ".agents", "skills")] : [])] }
function requireWorkspace(root: string, ...parts: string[]) { if (!root) throw new Error("An open workspace is required."); return path.join(root, ...parts) }
function requireAbsolutePath(value?: string) { if (!value || !path.isAbsolute(value)) throw new Error("An absolute file path is required."); return path.resolve(value) }
function safePathSegment(value: string) { const result = value.trim(); if (!result || !/^[a-zA-Z0-9._-]+$/.test(result) || result === "." || result === "..") throw new Error("The name contains unsupported characters."); return result }
function safeFileName(value: string) { const name = safePathSegment(value); return path.extname(name) ? name : `${name}.md` }
function assertAllowed(target: string, roots: readonly string[]) { if (!roots.some((root) => isInside(target, root))) throw new Error("Refusing to modify a file outside the supported instruction directories.") }
function isInside(target: string, root: string) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative)) }
function samePath(left: string, right: string) { return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase() }
async function createNewFile(target: string, content: string) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" }) }
async function resolveMentionPath(value: string, roots: readonly string[]) {
	const unquoted = value.replace(/^"|"$/g, "")
	const workspaceMatch = unquoted.match(/^([^:]+):\/(.+)$/)
	if (workspaceMatch) { const root = roots.find((item) => path.basename(item) === workspaceMatch[1]); const candidate = root ? confinedPath(root, workspaceMatch[2]) : ""; return candidate && await exists(candidate) ? candidate : "" }
	const relative = unquoted.replace(/^\/+/, "")
	for (const root of roots) { const candidate = confinedPath(root, relative); if (candidate && await exists(candidate)) return candidate }
	return ""
}
function confinedPath(root: string, relative: string) { const candidate = path.resolve(root, relative); return isInside(candidate, root) ? candidate : "" }
function fileUriToPath(value: string) { if (!value.startsWith("file:")) return value; const url = new URL(value); return decodeURIComponent(url.pathname.replace(/^\/(?:([a-zA-Z]:))/, "$1")).replace(/\//g, path.sep) }
function decodeImageDataUrl(value: string) { const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(value); return match ? { extension: `.${match[1] === "jpeg" ? "jpg" : match[1]}`, bytes: Buffer.from(match[2], "base64") } : null }
async function writeTemporaryFile(stem: string, extension: string, content: Uint8Array) { const directory = path.join(os.tmpdir(), "VsClineAgent", "open"); await fs.mkdir(directory, { recursive: true }); const target = path.join(directory, `${stem}-${Date.now()}${extension}`); await fs.writeFile(target, content); return target }
async function exists(filePath: string) { try { await fs.access(filePath); return true } catch { return false } }
