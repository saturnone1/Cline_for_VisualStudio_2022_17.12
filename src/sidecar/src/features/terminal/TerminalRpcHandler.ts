import type { WorkspacePort } from "../../application/ports/HostProviderPort"

export type TerminalCommand =
	| Readonly<{ type: "profiles" }>
	| Readonly<{ type: "open"; terminalId?: string; commandId?: string }>
	| Readonly<{ type: "attach"; terminalId?: string; commandId?: string }>
	| Readonly<{ type: "continue"; terminalId?: string; commandId?: string }>

export type TerminalRpcResult = Readonly<{ payload: unknown; includeStateMessages?: boolean }>

export class TerminalRpcHandler {
	constructor(private readonly workspace: WorkspacePort) {}

	async handle(command: TerminalCommand): Promise<TerminalRpcResult> {
		const request = "terminalId" in command ? { terminalId: command.terminalId, commandId: command.commandId } : {}
		switch (command.type) {
			case "profiles": return { payload: { profiles: [{ id: "visual-studio-command-host", name: "Visual Studio Command Host" }] } }
			case "open": return { payload: await this.workspace.openTerminalPanel(request) }
			case "attach": return { payload: await this.workspace.attachTerminalCommand(request), includeStateMessages: true }
			case "continue": return { payload: await this.workspace.continueTerminalCommand(request), includeStateMessages: true }
		}
	}
}
