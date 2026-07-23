import { ClineAsk as AppClineAsk, ClineMessage as AppClineMessage, ClineSay as AppClineSay } from "@shared/ExtensionMessage"
import { ClineAsk, ClineMessageType, ClineSay, ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { CLINE_ASK_KIND_MAP, CLINE_SAY_KIND_MAP } from "./generated/clineMessageKinds"

const ASK_KIND_MAP: Record<AppClineAsk, ClineAsk> = CLINE_ASK_KIND_MAP
const SAY_KIND_MAP: Record<AppClineSay, ClineSay> = CLINE_SAY_KIND_MAP
const ASK_KIND_REVERSE = reverseKindMap<AppClineAsk>(ASK_KIND_MAP)
const SAY_KIND_REVERSE = reverseKindMap<AppClineSay>(SAY_KIND_MAP)

// Helper function to convert ClineAsk string to enum
function convertClineAskToProtoEnum(ask: AppClineAsk | undefined): ClineAsk | undefined {
	if (!ask) {
		return undefined
	}

	return ASK_KIND_MAP[ask]
}

// Helper function to convert ClineAsk enum to string
function convertProtoEnumToClineAsk(ask: ClineAsk): AppClineAsk | undefined {
	if (ask === ClineAsk.UNRECOGNIZED) {
		return undefined
	}

	return ASK_KIND_REVERSE[ask]
}

// Helper function to convert ClineSay string to enum
function convertClineSayToProtoEnum(say: AppClineSay | undefined): ClineSay | undefined {
	if (!say) {
		return undefined
	}

	return SAY_KIND_MAP[say]
}

// Helper function to convert ClineSay enum to string
function convertProtoEnumToClineSay(say: ClineSay): AppClineSay | undefined {
	if (say === ClineSay.UNRECOGNIZED) {
		return undefined
	}

	return SAY_KIND_REVERSE[say]
}

function reverseKindMap<T extends string>(mapping: Readonly<Record<T, string>>) {
	const reversed: Record<string, T> = {}
	for (const [kind, proto] of Object.entries(mapping) as Array<[T, string]>) reversed[proto] ??= kind
	return reversed
}

/**
 * Convert application ClineMessage to proto ClineMessage
 */
export function convertClineMessageToProto(message: AppClineMessage): ProtoClineMessage {
	// For sending messages, we need to provide values for required proto fields
	const askEnum = message.ask ? convertClineAskToProtoEnum(message.ask) : undefined
	const sayEnum = message.say ? convertClineSayToProtoEnum(message.say) : undefined

	// Determine appropriate enum values based on message type
	let finalAskEnum: ClineAsk = ClineAsk.FOLLOWUP // Proto default
	let finalSayEnum: ClineSay = ClineSay.TEXT // Proto default

	if (message.type === "ask") {
		finalAskEnum = askEnum ?? ClineAsk.FOLLOWUP // Use FOLLOWUP as default for ask messages
	} else if (message.type === "say") {
		finalSayEnum = sayEnum ?? ClineSay.TEXT // Use TEXT as default for say messages
	}

	const protoMessage: ProtoClineMessage = {
		ts: message.ts,
		type: message.type === "ask" ? ClineMessageType.ASK : ClineMessageType.SAY,
		ask: finalAskEnum,
		say: finalSayEnum,
		text: message.text ?? "",
		reasoning: message.reasoning ?? "",
		images: message.images ?? [],
		files: message.files ?? [],
		partial: message.partial ?? false,
		lastCheckpointHash: message.lastCheckpointHash ?? "",
		isCheckpointCheckedOut: message.isCheckpointCheckedOut ?? false,
		isOperationOutsideWorkspace: message.isOperationOutsideWorkspace ?? false,
		conversationHistoryIndex: message.conversationHistoryIndex ?? 0,
		conversationHistoryDeletedRange: message.conversationHistoryDeletedRange
			? {
					startIndex: message.conversationHistoryDeletedRange[0],
					endIndex: message.conversationHistoryDeletedRange[1],
				}
			: undefined,
		// Additional optional fields for specific ask/say types
		sayTool: undefined,
		sayBrowserAction: undefined,
		browserActionResult: undefined,
		askUseMcpServer: undefined,
		planModeResponse: undefined,
		askQuestion: undefined,
		askNewTask: undefined,
		apiReqInfo: undefined,
		modelInfo: message.modelInfo ?? undefined,
	}

	return protoMessage
}

/**
 * Convert proto ClineMessage to application ClineMessage
 */
export function convertProtoToClineMessage(protoMessage: ProtoClineMessage): AppClineMessage {
	const message: AppClineMessage = {
		ts: protoMessage.ts,
		type: protoMessage.type === ClineMessageType.ASK ? "ask" : "say",
	}

	// Convert ask enum to string
	if (protoMessage.type === ClineMessageType.ASK) {
		const ask = convertProtoEnumToClineAsk(protoMessage.ask)
		if (ask !== undefined) {
			message.ask = ask
		}
	}

	// Convert say enum to string
	if (protoMessage.type === ClineMessageType.SAY) {
		const say = convertProtoEnumToClineSay(protoMessage.say)
		if (say !== undefined) {
			message.say = say
		}
	}

	// Convert other fields - preserve empty strings as they may be intentional
	if (protoMessage.text !== "") {
		message.text = protoMessage.text
	}
	if (protoMessage.reasoning !== "") {
		message.reasoning = protoMessage.reasoning
	}
	if (protoMessage.images.length > 0) {
		message.images = protoMessage.images
	}
	if (protoMessage.files.length > 0) {
		message.files = protoMessage.files
	}
	if (protoMessage.partial) {
		message.partial = protoMessage.partial
	}
	if (protoMessage.lastCheckpointHash !== "") {
		message.lastCheckpointHash = protoMessage.lastCheckpointHash
	}
	if (protoMessage.isCheckpointCheckedOut) {
		message.isCheckpointCheckedOut = protoMessage.isCheckpointCheckedOut
	}
	if (protoMessage.isOperationOutsideWorkspace) {
		message.isOperationOutsideWorkspace = protoMessage.isOperationOutsideWorkspace
	}
	if (protoMessage.conversationHistoryIndex !== 0) {
		message.conversationHistoryIndex = protoMessage.conversationHistoryIndex
	}

	// Convert conversationHistoryDeletedRange from object to tuple
	if (protoMessage.conversationHistoryDeletedRange) {
		message.conversationHistoryDeletedRange = [
			protoMessage.conversationHistoryDeletedRange.startIndex,
			protoMessage.conversationHistoryDeletedRange.endIndex,
		]
	}

	return message
}
