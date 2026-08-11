import { createSidecarConnectionScope } from "./bootstrap/SidecarConnectionFactory"
import { flushInteractionLog, interactionLogger } from "./infrastructure/diagnostics/InteractionLog"
import { JsonStateStore } from "./infrastructure/persistence/JsonStateStore"
import { SidecarRpcServer } from "./infrastructure/transport/SidecarRpcServer"

const pipeName = getArg("--pipe")
if (!pipeName) { console.error("Missing required --pipe argument."); process.exit(2) }

const stateStore = JsonStateStore.createDefault()
const server = new SidecarRpcServer(pipeName, interactionLogger, (connection) => createSidecarConnectionScope(connection, stateStore), flushInteractionLog)
server.start()

function getArg(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null }
