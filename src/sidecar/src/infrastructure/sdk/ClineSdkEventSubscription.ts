import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import { normalizeAgentRuntimeEvent } from "./ClineSdkEventTranslator"
import type { ClineSdkCore } from "./ClineSdkSessionAdapter"

type CoreSessionEvent = Parameters<ClineSdkCore["subscribe"]>[0] extends (event: infer T) => void ? T : unknown

export function subscribeToClineSdkEvents(core: ClineSdkCore, onEvent?: (event: AgentRuntimeEvent) => void) {
	if (!onEvent) return
	core.subscribe((event: CoreSessionEvent) => onEvent(normalizeAgentRuntimeEvent(event)))
}
