import { McpUseCase } from "./application/useCases/McpUseCase"
import { TaskSessionUseCase } from "./application/useCases/TaskSessionUseCase"
import { TaskLifecycleUseCase } from "./application/useCases/TaskLifecycleUseCase"
import { StatePersistenceUseCase } from "./application/useCases/StatePersistenceUseCase"
import { flushInteractionLog, interactionLogger } from "./infrastructure/diagnostics/InteractionLog"
import { VisualStudioHostProvider } from "./infrastructure/host/VisualStudioHostProvider"
import { JsonStateStore } from "./infrastructure/persistence/JsonStateStore"
import { ClineSdkRuntime } from "./infrastructure/sdk/ClineSdkRuntime"
import { JsonRpcWebviewTransport } from "./infrastructure/transport/JsonRpcConnection"
import { SidecarRpcServer } from "./infrastructure/transport/SidecarRpcServer"
import { VisualStudioWebviewBackend } from "./infrastructure/webview/VisualStudioWebviewBackend"
import { VisualStudioWebviewController } from "./presentation/webview/VisualStudioWebviewController"

const pipeName = getArg("--pipe")
if (!pipeName) {
	console.error("Missing required --pipe argument.")
	process.exit(2)
}

const stateStore = JsonStateStore.createDefault()
const server = new SidecarRpcServer(
	pipeName,
	interactionLogger,
	(connection) => {
		const host = VisualStudioHostProvider.create(connection)
		const statePersistence = new StatePersistenceUseCase(stateStore, readPositiveIntEnv("VSCLINE_STATE_SAVE_DEBOUNCE_MS", 250))
		const backend = new VisualStudioWebviewBackend(host, new JsonRpcWebviewTransport(connection), interactionLogger, statePersistence, new TaskLifecycleUseCase())
		const webview = new VisualStudioWebviewController(backend)
		const runtime = new ClineSdkRuntime(
			host,
			__dirname,
			(event) => webview.handleSdkEvent(event),
			(request) => webview.requestToolApproval(request),
			(question, options) => webview.requestQuestion(question, options),
			() => webview.isScheduledAgentsEnabled(),
		)
		backend.setClineSdk(runtime)
		backend.setTaskSessionUseCase(new TaskSessionUseCase(runtime))
		backend.setMcpUseCase(new McpUseCase(runtime))
		return { runtime, webview, roundtrip: () => host.roundtrip() }
	},
	flushInteractionLog,
)
server.start()

function getArg(name: string): string | null {
	const index = process.argv.indexOf(name)
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null
}

function readPositiveIntEnv(name: string, fallback: number) {
	const value = Number(process.env[name])
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
