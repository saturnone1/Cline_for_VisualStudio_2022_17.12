import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ComponentProps, ReactNode } from "react"
import { AskMessageRenderer } from "./AskMessageRenderer"
import { SayMessageRenderer } from "./SayMessageRenderer"

interface ChatMessageRendererRegistryProps {
	message: ClineMessage
	askProps: Omit<ComponentProps<typeof AskMessageRenderer>, "message">
	sayProps: Omit<ComponentProps<typeof SayMessageRenderer>, "message">
}

type RegisteredMessageType = ClineMessage["type"]
type MessageRenderer = (props: ChatMessageRendererRegistryProps) => ReactNode

const rendererRegistry: Record<RegisteredMessageType, MessageRenderer> = {
	ask: ({ message, askProps }) => <AskMessageRenderer {...askProps} message={message} />,
	say: ({ message, sayProps }) => <SayMessageRenderer {...sayProps} message={message} />,
}

export const CHAT_MESSAGE_RENDERER_TYPES = Object.freeze(
	Object.keys(rendererRegistry) as RegisteredMessageType[],
)

export function ChatMessageRendererRegistry(props: ChatMessageRendererRegistryProps) {
	return rendererRegistry[props.message.type](props)
}
