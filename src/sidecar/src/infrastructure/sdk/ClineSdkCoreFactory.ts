import path from "node:path"
import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { AgentRuntimeEvent, ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
import { translateToolApprovalRequest } from "./ClineSdkEventTranslator"
import { subscribeToClineSdkEvents } from "./ClineSdkEventSubscription"
import type { ClineSdkCore } from "./ClineSdkSessionAdapter"
import { createClineSdkToolExecutors } from "./ClineSdkToolExecutorFactory"
import { ensureUsableHomeEnvironment } from "./SdkEnvironment"

type ClineSdkModule = typeof import("@cline/sdk")

type CoreFactoryDependencies = {
	host: HostProviderPort
	getActiveSessionId: () => string | null
	onEvent?: (event: AgentRuntimeEvent) => void
	onToolApproval?: (request: ApprovalRequestedEvent) => Promise<ToolApprovalResult>
	onAskQuestion?: (question: string, options: string[]) => Promise<AskQuestionResult>
	isAutomationEnabled?: () => boolean
	log: (level: string, message: string, metadata?: unknown) => void
}

export async function createClineSdkCore(dependencies: CoreFactoryDependencies): Promise<ClineSdkCore> {
	ensureUsableHomeEnvironment()
	const sdk = await importClineSdk()
	const workspaceRoots = await dependencies.host.workspaceClient.getWorkspacePaths({}).catch(() => [] as string[])
	const workspaceRoot = workspaceRoots[0] || process.cwd()
	const automationEnabled = dependencies.isAutomationEnabled?.() === true || process.env.VSCLINE_ENABLE_AUTOMATION === "1"
	const automation = automationEnabled ? {
		cronScope: "workspace" as const,
		workspaceRoot,
		cronSpecsDir: path.join(workspaceRoot, ".cline", "cron"),
		autoStart: true,
	} : undefined
	const toolExecutors = createClineSdkToolExecutors(sdk, {
		host: dependencies.host,
		getActiveSessionId: dependencies.getActiveSessionId,
		onAskQuestion: dependencies.onAskQuestion,
		onEvent: dependencies.onEvent,
		log: (event, details) => dependencies.log("debug", event, details),
	})
	const core = await sdk.ClineCore.create({
		clientName: "VsClineAgent",
		backendMode: "local",
		...(automation ? { automation } : {}),
		capabilities: {
			requestToolApproval: async (request: unknown) => dependencies.onToolApproval
				? dependencies.onToolApproval(translateToolApprovalRequest(request, dependencies.getActiveSessionId() || ""))
				: { approved: false, reason: "Visual Studio tool approval UI is not attached." },
			toolExecutors,
		},
		logger: {
			debug: (message: string, metadata?: unknown) => dependencies.log("debug", message, metadata),
			log: (message: string, metadata?: unknown) => dependencies.log("info", message, metadata),
		},
	})
	subscribeToClineSdkEvents(core, dependencies.onEvent)
	return core
}

async function importClineSdk(): Promise<ClineSdkModule> {
	const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ClineSdkModule>
	return importEsm("@cline/sdk")
}
