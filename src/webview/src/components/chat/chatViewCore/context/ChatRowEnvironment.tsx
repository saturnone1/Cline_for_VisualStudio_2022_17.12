import type React from "react";
import { createContext, useContext } from "react";
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext";

export type ChatRowEnvironmentValue = Pick<
	ExtensionStateContextType,
	| "backgroundEditEnabled"
	| "mcpServers"
	| "mcpMarketplaceCatalog"
	| "onRelinquishControl"
	| "showFeatureTips"
>;

const ChatRowEnvironmentContext = createContext<ChatRowEnvironmentValue | undefined>(undefined);

export function ChatRowEnvironmentProvider({
	value,
	children,
}: {
	value: ChatRowEnvironmentValue;
	children: React.ReactNode;
}) {
	return <ChatRowEnvironmentContext.Provider value={value}>{children}</ChatRowEnvironmentContext.Provider>;
}

export function useChatRowEnvironment() {
	const context = useContext(ChatRowEnvironmentContext);
	if (!context) throw new Error("useChatRowEnvironment must be used within ChatRowEnvironmentProvider");
	return context;
}
