import type { ConversationProjectionState } from "../../features/conversation/ConversationProjectionState"
import {
	buildGroupedToolActivityText,
	normalizeAssistantTranscriptText,
	shouldDelayAssistantTextUntilClassified,
	shouldFoldTextContentAsReasoning,
	toolActivityEntriesFromMessage,
	toolActivityEntryKey,
} from "./ConversationSupport"
import { mergeTextDelta } from "./TranscriptTextPolicy"
import type { ConversationMessageStore } from "./ConversationMessageStore"
import type { FoldedProgressProjector } from "./FoldedProgressProjector"
import type { PartialTextProjector } from "./PartialTextProjector"

type ConversationRuntimeDependencies = {
	projection: ConversationProjectionState
	messages: () => Array<Record<string, unknown>>
	messageStore: ConversationMessageStore
	partial: PartialTextProjector
	folded: FoldedProgressProjector
	language: () => "en" | "ko"
	currentSessionId: () => string
	markFirstAssistant: (sessionId: string, textLength: number) => void
	schedulePartialIdle: () => void
	schedulePartialBroadcast: () => void
	addMessage: (message: Record<string, unknown>) => void
	publishPartial: (message: Record<string, unknown> | undefined) => void
}

export class ConversationRuntimeProjector {
	constructor(private readonly dependencies: ConversationRuntimeDependencies) {}

	recordToolActivity(tool: string, text: string) {
		const entries = toolActivityEntriesFromMessage(tool, text)
		if (entries.length === 0) return
		const activeEntries = this.dependencies.projection.mergeToolActivities(entries, toolActivityEntryKey)
		this.dependencies.folded.upsertActivity(buildGroupedToolActivityText(activeEntries, true, this.dependencies.language()))
	}

	finishToolActivity() {
		const entries = this.dependencies.projection.finishToolActivities()
		if (entries.length === 0) return
		this.dependencies.folded.upsertActivity(buildGroupedToolActivityText(entries, false, this.dependencies.language()))
	}

	upsertAssistant(accumulated: string, delta: string) {
		const projection = this.dependencies.projection
		const nextText = accumulated || mergeTextDelta(projection.activeAssistantTextBuffer, delta)
		const normalized = normalizeAssistantTranscriptText(nextText)
		if (!normalized) return
		this.dependencies.markFirstAssistant(this.dependencies.currentSessionId(), normalized.length)
		projection.activeAssistantTextBuffer = normalized
		if (shouldFoldTextContentAsReasoning(normalized)) {
			this.dependencies.folded.upsertReasoning(normalized)
			return
		}
		if (!accumulated && shouldDelayAssistantTextUntilClassified(normalized)) {
			this.dependencies.schedulePartialIdle()
			this.dependencies.schedulePartialBroadcast()
			return
		}
		this.finishToolActivity()
		this.dependencies.folded.finish()
		this.dependencies.partial.upsert(normalized)
	}

	completeAssistant(text: string) {
		this.finishToolActivity()
		this.dependencies.folded.finish()
		const projection = this.dependencies.projection
		const timestamp = projection.activePartialTextTs
		if (timestamp) {
			this.dependencies.messageStore.upsert(timestamp, { type: "say", say: "text", text, partial: false })
			this.dependencies.publishPartial(this.dependencies.messages().find((message) => message.ts === timestamp))
			projection.activePartialTextTs = null
		} else {
			this.dependencies.addMessage({ type: "say", say: "text", text })
		}
		projection.activeAssistantTextBuffer = ""
	}
}
