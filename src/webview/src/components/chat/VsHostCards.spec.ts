import { parseVsCommandOutputSummary } from "./VsHostCards"

describe("parseVsCommandOutputSummary", () => {
	it("projects Visual Studio command metadata and output sections", () => {
		const [command] = parseVsCommandOutputSummary(`dotnet build
commandId=cmd-17
terminal=vs-host
cwd=C:\\repo
status=completed
exitCode=0
durationMs=1250
stdout:
Build succeeded.
stderr:
warning sample`)

		expect(command).toMatchObject({
			command: "dotnet build",
			commandId: "cmd-17",
			terminalId: "vs-host",
			cwd: "C:\\repo",
			status: "completed",
			exitCode: 0,
			durationMs: 1250,
			stdout: "Build succeeded.",
			stderr: "warning sample",
		})
	})

	it("preserves live terminal capabilities", () => {
		const [command] = parseVsCommandOutputSummary(`npm run dev
commandId=cmd-live
terminal=terminal-1
background=true
hotProcess=true
attachable=true
proceedWhileRunning=true`)

		expect(command).toMatchObject({
			background: true,
			hotProcess: true,
			attachable: true,
			proceedWhileRunning: true,
		})
	})
})
