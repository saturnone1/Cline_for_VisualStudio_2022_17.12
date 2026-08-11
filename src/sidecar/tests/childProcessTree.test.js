const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const test = require("node:test")
const { terminateChildProcessTree } = require("../dist/infrastructure/process/ChildProcessTree")

test("owned child processes are confirmed stopped before cancellation completes", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" })
	await new Promise((resolve, reject) => {
		child.once("spawn", resolve)
		child.once("error", reject)
	})
	await terminateChildProcessTree(child, 5000)
	assert.notEqual(child.exitCode ?? child.signalCode, null)
})

test("Windows cancellation terminates descendants of an owned tool process", { skip: process.platform !== "win32" }, async () => {
	const script = [
		"const { spawn } = require('node:child_process')",
		"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
		"console.log(child.pid)",
		"setInterval(() => {}, 1000)",
	].join(";")
	const parent = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
	const descendantPid = await new Promise((resolve, reject) => {
		parent.once("error", reject)
		parent.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())))
	})
	assert.ok(descendantPid > 0)
	await terminateChildProcessTree(parent, 5000)
	await waitUntil(() => !isProcessAlive(descendantPid), 5000)
	assert.equal(isProcessAlive(descendantPid), false)
})

function isProcessAlive(pid) {
	try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
}
