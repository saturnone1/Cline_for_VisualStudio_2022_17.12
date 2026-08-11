import { spawn, type ChildProcess } from "node:child_process"

export async function terminateChildProcessTree(child: ChildProcess, timeoutMs = terminationTimeoutMs()) {
	if (!child.pid || hasExited(child)) return
	if (process.platform === "win32") {
		await runTaskkill(child.pid, timeoutMs)
	} else {
		try { child.kill("SIGTERM") } catch { /* process already exited */ }
	}
	if (await waitForExit(child, timeoutMs)) return
	try { child.kill("SIGKILL") } catch { /* process already exited */ }
	if (await waitForExit(child, Math.min(timeoutMs, 2000))) return
	throw new Error(`Child process tree did not terminate: ${child.pid}`)
}

function runTaskkill(pid: number, timeoutMs: number) {
	return new Promise<void>((resolve) => {
		const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve()
		}
		const timer = setTimeout(() => {
			try { killer.kill() } catch { /* taskkill already exited */ }
			finish()
		}, timeoutMs)
		killer.once("error", finish)
		killer.once("close", finish)
	})
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
	if (hasExited(child)) return Promise.resolve(true)
	return new Promise<boolean>((resolve) => {
		let settled = false
		const finish = (exited: boolean) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.off("close", onClose)
			child.off("exit", onClose)
			resolve(exited || hasExited(child))
		}
		const onClose = () => finish(true)
		const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs))
		child.once("close", onClose)
		child.once("exit", onClose)
		if (hasExited(child)) finish(true)
	})
}

function hasExited(child: ChildProcess) {
	return child.exitCode !== null || child.signalCode !== null
}

function terminationTimeoutMs() {
	const value = Number(process.env.VSCLINE_CHILD_PROCESS_TERMINATION_MS)
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5000
}
