import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences";
import { ClineApiReqInfo, ClineAskUseMcpServer, ClineMessage, ClineSayTool } from "@shared/ExtensionMessage";
import { Mode } from "@shared/storage/types";
import deepEqual from "fast-deep-equal";
import { CircleXIcon, LoaderCircleIcon, TerminalIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSize } from "react-use";
import McpResourceRow from "@/components/mcp/configuration/tabs/installed/serverRow/McpResourceRow";
import McpToolRow from "@/components/mcp/configuration/tabs/installed/serverRow/McpToolRow";
import { useI18n } from "@/i18n";
import { findMatchingResourceOrTemplate, getMcpServerDisplayName } from "@/utils/mcp";
import CodeAccordian from "../common/CodeAccordian";
import { ChatMessageRendererRegistry } from "./ChatMessageRendererRegistry";
import { CommandOutputRow } from "./CommandOutputRow";
import SubagentStatusRow from "./SubagentStatusRow";
import { ToolMessageRenderer } from "./ToolMessageRenderer";
import { useQuoteSelection } from "./useQuoteSelection";
import { useChatRowEnvironment } from "./chatViewCore/context/ChatRowEnvironment";
import { parseJsonObject } from "./chatViewCore/utils/safeJson";

const HEADER_CLASSNAMES = "flex items-center gap-2.5 mb-3";

interface ChatRowProps {
	message: ClineMessage;
	isExpanded: boolean;
	onToggleExpand: (ts: number) => void;
	lastModifiedMessage?: ClineMessage;
	isLast: boolean;
	onHeightChange: (isTaller: boolean) => void;
	inputValue?: string;
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void;
	onSetQuote: (text: string) => void;
	onCancelCommand?: () => void;
	mode?: Mode;
}

interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}

export const ProgressIndicator = () => <LoaderCircleIcon className="size-2 mr-2 animate-spin" />;
const InvisibleSpacer = () => <div aria-hidden className="h-px" />;

const ChatRow = memo(
	(props: ChatRowProps) => {
		const { isLast, onHeightChange, message } = props;
		// Store the previous height to compare with the current height
		// This allows us to detect changes without causing re-renders
		const prevHeightRef = useRef(0);

		const [chatrow, { height }] = useSize(
			<div className="relative pt-2.5 px-4">
				<ChatRowContent {...props} />
			</div>,
		);

		useEffect(() => {
			// used for partials command output etc.
			// NOTE: it's important we don't distinguish between partial or complete here since our scroll effects in chatview need to handle height change during partial -> complete
			const isInitialRender = prevHeightRef.current === 0; // prevents scrolling when new element is added since we already scroll for that
			// height starts off at Infinity
			if (isLast && height !== 0 && height !== Number.POSITIVE_INFINITY && height !== prevHeightRef.current) {
				if (!isInitialRender) {
					onHeightChange(height > prevHeightRef.current);
				}
				prevHeightRef.current = height;
			}
		}, [height, isLast, onHeightChange, message]);

		// we cannot return null as virtuoso does not support it so we use a separate visibleMessages array to filter out messages that should not be rendered
		return chatrow;
	},
	// memo does shallow comparison of props, so we need to do deep comparison of arrays/objects whose properties might change
	deepEqual,
);

export default ChatRow;

export const ChatRowContent = memo(
	({
		message,
		isExpanded,
		onToggleExpand,
		lastModifiedMessage,
		isLast,
		inputValue,
		sendMessageFromChatRow,
		onSetQuote,
		onCancelCommand,
		mode,
	}: ChatRowContentProps) => {
		const {
			backgroundEditEnabled,
			mcpServers,
			mcpMarketplaceCatalog,
			onRelinquishControl,
			showFeatureTips,
		} = useChatRowEnvironment();
		const { t, language } = useI18n();
		const [seeNewChangesDisabled, setSeeNewChangesDisabled] = useState(false);
		const [explainChangesDisabled, setExplainChangesDisabled] = useState(false);
		const { quoteButtonState, contentRef, handleQuoteClick, handleMouseUp } = useQuoteSelection(onSetQuote);

		// Command output expansion state (for all messages, but only used by command messages)
		const [isOutputFullyExpanded, setIsOutputFullyExpanded] = useState(false);
		const prevCommandExecutingRef = useRef<boolean>(false);

		const hasAutoExpandedRef = useRef(false);
		const hasAutoCollapsedRef = useRef(false);
		const prevIsLastRef = useRef(isLast);

		// Auto-expand completion output when it's the last message (runs once per message)
		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result";

			// Auto-expand if it's last and we haven't already auto-expanded
			if (isLast && isCompletionResult && !hasAutoExpandedRef.current) {
				hasAutoExpandedRef.current = true;
				hasAutoCollapsedRef.current = false; // Reset the auto-collapse flag when expanding
			}
		}, [isLast, message.ask, message.say]);

		// Auto-collapse completion output ONCE when transitioning from last to not-last
		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result";
			const wasLast = prevIsLastRef.current;

			// Only auto-collapse if transitioning from last to not-last, and we haven't already auto-collapsed
			if (wasLast && !isLast && isCompletionResult && !hasAutoCollapsedRef.current) {
				hasAutoCollapsedRef.current = true;
				hasAutoExpandedRef.current = false; // Reset the auto-expand flag when collapsing
			}

			prevIsLastRef.current = isLast;
		}, [isLast, message.ask, message.say]);

		const [cost, apiReqStreamingFailedMessage] = useMemo(() => {
			if (message.text != null && message.say === "api_req_started") {
				const info = parseJsonObject<ClineApiReqInfo>(message.text);
				return [info.cost, info.streamingFailedMessage];
			}
			return [undefined, undefined];
		}, [message.text, message.say]);

		// when resuming task last won't be api_req_failed but a resume_task message so api_req_started will show loading spinner. that's why we just remove the last api_req_started that failed without streaming anything
		const apiRequestFailedMessage =
			isLast && lastModifiedMessage?.ask === "api_req_failed" // if request is retried then the latest message is a api_req_retried
				? lastModifiedMessage?.text
				: undefined;

		const type = message.type === "ask" ? message.ask : message.say;

		const isCommandMessage = type === "command";
		// Check if command has output to determine if it's actually executing
		const commandHasOutput = message.text?.includes(COMMAND_OUTPUT_STRING) ?? false;
		// A command is executing if it has output but hasn't completed yet
		const isCommandExecuting = isCommandMessage && !message.commandCompleted && commandHasOutput;
		// A command is pending if it hasn't started (no output) and hasn't completed
		const isCommandPending = isCommandMessage && isLast && !message.commandCompleted && !commandHasOutput;
		const isCommandCompleted = isCommandMessage && message.commandCompleted === true;

		const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started";

		const handleToggle = useCallback(() => {
			onToggleExpand(message.ts);
		}, [onToggleExpand, message.ts]);

		// Use the onRelinquishControl hook instead of message event
		useEffect(() => {
			return onRelinquishControl(() => {
				setSeeNewChangesDisabled(false);
				setExplainChangesDisabled(false);
			});
		}, [onRelinquishControl]);

		// --- Quote Button Logic ---
		const [icon, title] = useMemo(() => {
			switch (type) {
				case "error":
					return [
						<span className="codicon codicon-error text-error mb-[-1.5px]" />,
						<span className="text-error font-bold">Error</span>,
					];
				case "mistake_limit_reached":
					return [
						<CircleXIcon className="text-error size-2" />,
						<span className="text-error font-bold">
							{language === "ko" ? "LIG VS가 문제를 처리하는 중입니다..." : "LIG VS is having trouble..."}
						</span>,
					];
				case "command":
					return [
						<TerminalIcon className="text-foreground size-2" />,
						<span className="font-bold text-foreground">{t("command.title")}</span>,
					];
				case "use_mcp_server":
					const mcpServerUse = parseJsonObject<ClineAskUseMcpServer>(message.text);
					return [
						isMcpServerResponding ? (
							<ProgressIndicator />
						) : (
							<span className="codicon codicon-server text-foreground mb-[-1.5px]" />
						),
						<span className="ph-no-capture font-bold text-foreground break-words">
							LIG VS가{" "}
							<code className="break-all">
								{getMcpServerDisplayName(mcpServerUse.serverName, mcpMarketplaceCatalog)}
							</code>{" "}
							MCP 서버에서{" "}
							{mcpServerUse.type === "use_mcp_tool" ? "도구를 사용하려고 합니다:" : "리소스에 접근하려고 합니다:"}
						</span>,
					];
				case "completion_result":
					return [
						<span className="codicon codicon-check text-success mb-[-1.5px]" />,
						<span className="text-success font-bold">작업 완료</span>,
					];
				case "api_req_started":
					// API request rows no longer render the request payload/cost accordion.
					// Thinking/reasoning is handled directly in the api_req_started renderer below.
					return [null, null];
				case "followup":
					return [
						<span className="codicon codicon-question text-foreground mb-[-1.5px]" />,
						<span className="font-bold text-foreground">LIG VS 질문:</span>,
					];
				default:
					return [null, null];
			}
		}, [
			type,
			cost,
			apiRequestFailedMessage,
			isCommandExecuting,
			isCommandPending,
			isMcpServerResponding,
			message.text,
		]);

		const tool = useMemo(() => {
			if (message.ask === "tool" || message.say === "tool") {
				return parseJsonObject<ClineSayTool>(message.text);
			}
			return null;
		}, [message.ask, message.say, message.text]);

		const conditionalRulesInfo = useMemo(() => {
			if (message.say !== "conditional_rules_applied" || !message.text) return null;
			try {
				const parsed = JSON.parse(message.text) as unknown;
				if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).rules)) {
					return null;
				}
				return parsed as {
					rules: Array<{
						name: string;
						matchedConditions: Record<string, string[]>;
					}>;
				};
			} catch {
				return null;
			}
		}, [message.say, message.text]);

		// These effects must run before any message-type return so React sees the
		// same hook order when a streamed row changes from tool to command output.
		useEffect(() => {
			if (isCommandMessage && prevCommandExecutingRef.current && !isCommandExecuting) {
				setIsOutputFullyExpanded(false);
			}
			prevCommandExecutingRef.current = isCommandExecuting;
		}, [isCommandMessage, isCommandExecuting]);

		useEffect(() => {
			if (isCommandMessage && isCommandExecuting && !isExpanded) {
				onToggleExpand(message.ts);
			}
		}, [isCommandMessage, isCommandExecuting, isExpanded, onToggleExpand, message.ts]);

		if (conditionalRulesInfo) {
			const names = conditionalRulesInfo.rules.map((r: { name: string }) => r.name).join(", ");
			return (
				<div className={HEADER_CLASSNAMES}>
					<span style={{ fontWeight: "bold" }}>Conditional rules applied:</span>
					<span className="ph-no-capture break-words whitespace-pre-wrap">{names}</span>
				</div>
			);
		}

		if (tool) {
			return (
				<ToolMessageRenderer
					backgroundEditEnabled={backgroundEditEnabled}
					isExpanded={isExpanded}
					message={message}
					onToggle={handleToggle}
					tool={tool}
				/>
			);
		}

		if (message.ask === "command" || message.say === "command") {
			return (
				<CommandOutputRow
					icon={icon}
					isCommandCompleted={isCommandCompleted}
					isCommandExecuting={isCommandExecuting}
					isCommandPending={isCommandPending}
					isOutputFullyExpanded={isOutputFullyExpanded}
					message={message}
					onCancelCommand={onCancelCommand}
					setIsOutputFullyExpanded={setIsOutputFullyExpanded}
					title={title}
				/>
			);
		}

		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />;
		}

		if (message.ask === "use_mcp_server" || message.say === "use_mcp_server") {
			const useMcpServer = parseJsonObject<ClineAskUseMcpServer>(message.text);
			const server = mcpServers.find((server) => server.name === useMcpServer.serverName);
			return (
				<div>
					<div className={HEADER_CLASSNAMES}>
						{icon}
						{title}
					</div>

					<div className="bg-code rounded-xs py-2 px-2.5 mt-2">
						{useMcpServer.type === "access_mcp_resource" && (
							<McpResourceRow
								item={{
									...(findMatchingResourceOrTemplate(
										useMcpServer.uri || "",
										server?.resources,
										server?.resourceTemplates,
									) || {
										name: "",
										mimeType: "",
										description: "",
									}),
									uri: useMcpServer.uri || "",
								}}
							/>
						)}

						{useMcpServer.type === "use_mcp_tool" && (
							<div>
								<div onClick={(e) => e.stopPropagation()}>
									<McpToolRow
										serverName={useMcpServer.serverName}
										tool={{
											name: useMcpServer.toolName || "",
											description:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.description || "",
											autoApprove:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.autoApprove || false,
										}}
									/>
								</div>
								{useMcpServer.arguments && useMcpServer.arguments !== "{}" && (
									<div className="mt-2">
										<div className="mb-1 opacity-80 uppercase">{t("tool.arguments")}</div>
										<CodeAccordian
											code={useMcpServer.arguments}
											isExpanded={true}
											language="json"
											onToggleExpand={handleToggle}
										/>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			);
		}

		return (
			<ChatMessageRendererRegistry
				message={message}
				sayProps={{
					apiReqStreamingFailedMessage,
					apiRequestFailedMessage,
					contentRef,
					cost,
					explainChangesDisabled,
					handleMouseUp,
					handleQuoteClick,
					handleToggle,
					icon,
					isExpanded,
					isLast,
					lastModifiedMessage,
					mode,
					quoteButtonState,
					seeNewChangesDisabled,
					sendMessageFromChatRow,
					setExplainChangesDisabled,
					setSeeNewChangesDisabled,
					showFeatureTips,
					title,
				}}
				askProps={{
					contentRef,
					explainChangesDisabled,
					handleMouseUp,
					handleQuoteClick,
					icon,
					inputValue,
					isLast,
					lastModifiedMessage,
					quoteButtonState,
					seeNewChangesDisabled,
					setExplainChangesDisabled,
					setSeeNewChangesDisabled,
					title,
				}}
			/>
		);
	},
);
