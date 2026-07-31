import { combineApiRequests } from "@shared/combineApiRequests";
import { combineCommandSequences } from "@shared/combineCommandSequences";
import { combineErrorRetryMessages } from "@shared/combineErrorRetryMessages";
import { combineHookSequences } from "@shared/combineHookSequences";
import { getApiMetrics, getContextWindowUsage, getLastApiReqTotalTokens } from "@shared/getApiMetrics";
import type { ClineMessage } from "@shared/ExtensionMessage";
import { BooleanRequest, StringRequest } from "@shared/proto/cline/common";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMount } from "react-use";
import { normalizeApiConfiguration } from "@/components/settings/utils/providerUtils";
import { useExtensionState } from "@/context/ExtensionStateContext";
import { useLiveTaskMessages } from "@/context/TaskStreamState";
import { useShowNavbar } from "@/context/PlatformContext";
import { FileServiceClient, UiServiceClient } from "@/services/grpcClient";
import { superviseStreamSubscription } from "@/services/streamSubscriptionSupervisor";
import { Navbar } from "../menu/Navbar";
import AutoApproveBar from "./autoApproveMenu/AutoApproveBar";
import { deriveRequestPendingState, type RequestPendingState } from "./chatViewCore/utils/requestPendingState";
// Import utilities and hooks from the new structure
import {
	ActionButtons,
	CHAT_CONSTANTS,
	ChatLayout,
	convertHtmlToMarkdownWithFallback,
	filterVisibleMessages,
	getTaskMessage,
	groupLowStakesTools,
	groupMessages,
	InputSection,
	MessagesArea,
	TaskSection,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
	WelcomeSection,
} from "./chatViewCore";

interface ChatViewProps {
	isHidden: boolean;
	showAnnouncement: boolean;
	hideAnnouncement: () => void;
	showHistoryView: () => void;
}

// Use constants from the imported module
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE;
const QUICK_WINS_HISTORY_THRESHOLD = 3;

const ChatView = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	const showNavbar = useShowNavbar();
	const {
		version,
		taskHistory,
		apiConfiguration,
		telemetrySetting,
		mode,
		userInfo,
		currentFocusChainChecklist,
		focusChainSettings,
		hooksEnabled,
		currentTaskItem,
		taskLifecycleStatus,
		contextCompactionInProgress,
	} = useExtensionState();
	const messages = useLiveTaskMessages();
	const isProdHostedApp = userInfo?.apiBaseUrl === "https://app.cline.bot";
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD);
	const deferredMessages = useDeferredValue(messages);

	const task = useMemo(() => getTaskMessage(messages), [messages]);
	const modifiedMessages = useMemo(() => {
		const taskIndex = task ? deferredMessages.findIndex((message) => message.ts === task.ts) : -1;
		const slicedMessages = taskIndex >= 0 ? deferredMessages.slice(taskIndex + 1) : deferredMessages;
		// Only combine hook sequences if hooks are enabled
		const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages;
		return combineErrorRetryMessages(combineApiRequests(combineCommandSequences(withHooks)));
	}, [deferredMessages, hooksEnabled, task]);
	// has to be after api_req_finished are all reduced into api_req_started messages
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages]);

	const lastApiReqTotalTokens = useMemo(
		() => getLastApiReqTotalTokens(modifiedMessages) || undefined,
		[modifiedMessages],
	);
	// Context boundaries must update immediately after SDK compaction. Heavy chat
	// grouping can remain deferred, but deferring this value can leave the old
	// pre-compaction total visible throughout a continuing response stream.
	const contextWindowUsage = useMemo(() => getContextWindowUsage(messages), [messages]);
	// Use custom hooks for state management
	const chatState = useChatState(messages);
	const {
		setInputValue,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		sendingDisabled,
		enableButtons,
		expandedRows,
		setExpandedRows,
		textAreaRef,
	} = chatState;

	useEffect(() => {
		const handleCopy = async (e: ClipboardEvent) => {
			const targetElement = e.target as HTMLElement | null;
			// If the copy event originated from an input or textarea,
			// let the default browser behavior handle it.
			if (
				targetElement &&
				(targetElement.tagName === "INPUT" || targetElement.tagName === "TEXTAREA" || targetElement.isContentEditable)
			) {
				return;
			}

			if (window.getSelection) {
				const selection = window.getSelection();
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0);
					const commonAncestor = range.commonAncestorContainer;
					let textToCopy: string | null = null;

					// Check if the selection is inside an element where plain text copy is preferred
					let currentElement =
						commonAncestor.nodeType === Node.ELEMENT_NODE
							? (commonAncestor as HTMLElement)
							: commonAncestor.parentElement;
					let preferPlainTextCopy = false;
					while (currentElement) {
						if (currentElement.tagName === "PRE" && currentElement.querySelector("code")) {
							preferPlainTextCopy = true;
							break;
						}
						// Check computed white-space style
						const computedStyle = window.getComputedStyle(currentElement);
						if (
							computedStyle.whiteSpace === "pre" ||
							computedStyle.whiteSpace === "pre-wrap" ||
							computedStyle.whiteSpace === "pre-line"
						) {
							// If the element itself or an ancestor has pre-like white-space,
							// and the selection is likely contained within it, prefer plain text.
							// This helps with elements like the TaskHeader's text display.
							preferPlainTextCopy = true;
							break;
						}

						// Stop searching if we reach a known chat message boundary or body
						if (
							currentElement.classList.contains("chat-row-assistant-message-container") ||
							currentElement.classList.contains("chat-row-user-message-container") ||
							currentElement.tagName === "BODY"
						) {
							break;
						}
						currentElement = currentElement.parentElement;
					}

					if (preferPlainTextCopy) {
						// For code blocks or elements with pre-formatted white-space, get plain text.
						textToCopy = selection.toString();
					} else {
						// For other content, use the existing HTML-to-Markdown conversion
						const clonedSelection = range.cloneContents();
						const div = document.createElement("div");
						div.appendChild(clonedSelection);
						const selectedHtml = div.innerHTML;
						textToCopy = await convertHtmlToMarkdownWithFallback(selectedHtml, selection.toString());
					}

					if (textToCopy !== null) {
						let handledByClipboardData = false;
						if (e.clipboardData) {
							e.clipboardData.setData("text/plain", textToCopy);
							handledByClipboardData = true;
							e.preventDefault();
						}
						FileServiceClient.copyToClipboard(StringRequest.create({ value: textToCopy })).catch((err) => {
							console.error("Error copying to clipboard:", err);
							if (!handledByClipboardData) {
								console.warn("Copy fallback failed and default copy was preserved.");
							}
						});
					}
				}
			}
		};
		document.addEventListener("copy", handleCopy);

		return () => {
			document.removeEventListener("copy", handleCopy);
		};
	}, []);
	// Button state is now managed by useButtonState hook

	// handleFocusChange is already provided by chatState

	// Use message handlers hook
	const messageHandlers = useMessageHandlers(messages, chatState);

	const { selectedModelInfo } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration, mode);
	}, [apiConfiguration, mode]);
	const modelAcceptsImageAttachments = selectedModelInfo.supportsImages !== false;
	const [filePickerStatus, setFilePickerStatus] = useState("");
	const isHiddenRef = useRef(isHidden);
	const focusFrameRef = useRef<number>();
	isHiddenRef.current = isHidden;

	const selectFilesAndImages = useCallback(async () => {
		try {
			setFilePickerStatus("");
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: modelAcceptsImageAttachments,
				}),
			);
			if (response && response.values1 && response.values2) {
				const unsupportedImageCount = modelAcceptsImageAttachments
					? 0
					: response.values1.length + response.values2.filter(isImageFilePath).length;
				const candidateImages = modelAcceptsImageAttachments ? response.values1 : [];
				const candidateFiles = modelAcceptsImageAttachments
					? response.values2
					: response.values2.filter((file) => !isImageFilePath(file));
				if (unsupportedImageCount > 0) {
					setFilePickerStatus("현재 모델은 이미지 입력을 지원하지 않습니다.");
				}
				if (candidateImages.length === 0 && candidateFiles.length === 0) return;
				const currentTotal = selectedImages.length + selectedFiles.length;
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal;

				if (availableSlots > 0) {
					// Prioritize images first
					const imagesToAdd = Math.min(candidateImages.length, availableSlots);
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...candidateImages.slice(0, imagesToAdd)]);
					}

					// Use remaining slots for files
					const remainingSlots = availableSlots - imagesToAdd;
					const filesToAdd = Math.min(candidateFiles.length, remainingSlots);
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...candidateFiles.slice(0, filesToAdd)]);
					}
					const skipped = candidateImages.length + candidateFiles.length - imagesToAdd - filesToAdd;
					if (unsupportedImageCount === 0) setFilePickerStatus(
						skipped > 0 ? `Attached files. ${skipped} item(s) were skipped because the limit is reached.` : "",
					);
				} else {
					setFilePickerStatus("Attachment limit reached.");
				}
			} else {
				setFilePickerStatus("No files selected.");
			}
		} catch (error) {
			console.error("Error selecting images & files:", error);
			setFilePickerStatus("Could not open file picker. Check the Visual Studio status bar for details.");
		}
	}, [
		selectedFiles.length,
		selectedImages.length,
		modelAcceptsImageAttachments,
		setSelectedFiles,
		setSelectedImages,
	]);

	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE;

	// Keep host UI streams alive across navigation and sidecar restarts.
	useEffect(() => {
		const cleanup = superviseStreamSubscription<{ preserveEditorFocus?: boolean }>({
			label: "show webview",
			subscribe: (observer) => UiServiceClient.subscribeToShowWebview({}, observer),
			onResponse: (event) => {
				if (!isHiddenRef.current && !event.preserveEditorFocus) {
					textAreaRef.current?.focus();
				}
			},
			reportError: (label, error) => console.error(`Error in ${label} subscription:`, error),
		});

		return cleanup;
	}, [textAreaRef]);

	useEffect(() => {
		const cleanup = superviseStreamSubscription<{ value?: string }>({
			label: "add to input",
			subscribe: (observer) => UiServiceClient.subscribeToAddToInput({}, observer),
			onResponse: (event) => {
				if (!event.value) return;
				setInputValue((prevValue) => {
					const newTextWithNewline = `${event.value}\n`;
					return prevValue ? `${prevValue}\n${newTextWithNewline}` : newTextWithNewline;
				});
				if (focusFrameRef.current !== undefined) cancelAnimationFrame(focusFrameRef.current);
				focusFrameRef.current = requestAnimationFrame(() => {
					focusFrameRef.current = undefined;
					if (textAreaRef.current) {
						textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
						textAreaRef.current.focus();
					}
				});
			},
			reportError: (label, error) => console.error(`Error in ${label} subscription:`, error),
		});

		return () => {
			cleanup();
			if (focusFrameRef.current !== undefined) {
				cancelAnimationFrame(focusFrameRef.current);
				focusFrameRef.current = undefined;
			}
		};
	}, [setInputValue, textAreaRef]);

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus();
	});

	const visibleMessages = useMemo(() => {
		return filterVisibleMessages(modifiedMessages);
	}, [modifiedMessages]);

	const lastProgressMessageText = useMemo(() => {
		if (!focusChainSettings.enabled) {
			return undefined;
		}

		// First check if we have a current focus chain list from the extension state
		if (currentFocusChainChecklist) {
			return currentFocusChainChecklist;
		}

		// Fall back to the last task_progress message if no state focus chain list
		const lastProgressMessage = [...modifiedMessages].reverse().find((message) => message.say === "task_progress");
		return lastProgressMessage?.text;
	}, [focusChainSettings.enabled, modifiedMessages, currentFocusChainChecklist]);

	const showFocusChainPlaceholder = useMemo(() => {
		// Show placeholder whenever focus chain is enabled and no checklist exists yet.
		return focusChainSettings.enabled && !lastProgressMessageText;
	}, [focusChainSettings.enabled, lastProgressMessageText]);

	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages));
	}, [visibleMessages]);

	// Use scroll behavior hook
	const scrollBehavior = useScrollBehavior(messages, visibleMessages, groupedMessages, expandedRows, setExpandedRows);

	const placeholderText = useMemo(() => {
		const text = task ? "Type a message..." : "Type your task here...";
		return text;
	}, [task]);

	const taskKey = String(currentTaskItem?.id || task?.ts || "");
	const [requestPendingState, setRequestPendingState] = useState<RequestPendingState>({
		taskKey: "",
		turnTs: 0,
		pending: false,
	});
	useLayoutEffect(() => {
		setRequestPendingState((previous) => deriveRequestPendingState(previous, taskKey, messages, taskLifecycleStatus));
	}, [messages, taskKey, taskLifecycleStatus]);
	const requestPending = requestPendingState.pending;

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="flex flex-col flex-1 overflow-hidden">
				{showNavbar && <Navbar />}
				{task ? (
					<TaskSection
						apiMetrics={apiMetrics}
						contextCompactionInProgress={contextCompactionInProgress === true}
						contextWindowUsage={contextWindowUsage}
						lastApiReqTotalTokens={lastApiReqTotalTokens}
						lastProgressMessageText={lastProgressMessageText}
						messageHandlers={messageHandlers}
						messages={messages}
						selectedModelInfo={{
							supportsPromptCache: selectedModelInfo.supportsPromptCache,
							supportsImages: modelAcceptsImageAttachments,
						}}
						showFocusChainPlaceholder={showFocusChainPlaceholder}
						task={task}
					/>
				) : (
					<WelcomeSection
						hideAnnouncement={hideAnnouncement}
						shouldShowQuickWins={shouldShowQuickWins}
						showAnnouncement={showAnnouncement}
						showHistoryView={showHistoryView}
						taskHistory={taskHistory}
						telemetrySetting={telemetrySetting}
						version={version}
					/>
				)}
				{task && (
					<MessagesArea
						chatState={chatState}
						groupedMessages={groupedMessages}
						messageHandlers={messageHandlers}
						modifiedMessages={modifiedMessages}
						scrollBehavior={scrollBehavior}
						task={task}
					/>
				)}
			</div>
			<footer className="bg-(--vscode-sidebar-background)" style={{ gridRow: "2" }}>
				<AutoApproveBar />
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode}
					requestPending={requestPending}
					scrollBehavior={{
						scrollToBottomSmooth: scrollBehavior.scrollToBottomSmooth,
						disableAutoScrollRef: scrollBehavior.disableAutoScrollRef,
						showScrollToBottom: scrollBehavior.showScrollToBottom,
						virtuosoRef: scrollBehavior.virtuosoRef,
					}}
					task={task}
				/>
				{filePickerStatus && (
					<div className="px-3.5 pb-1 text-xs text-(--vscode-descriptionForeground)" role="status">
						{filePickerStatus}
					</div>
				)}
				<InputSection
					chatState={chatState}
					messageHandlers={messageHandlers}
					placeholderText={placeholderText}
					requestPending={requestPending}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				/>
			</footer>
		</ChatLayout>
	);
};

function isImageFilePath(value: string) {
	return /\.(png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/i.test(value.trim());
}

export default ChatView;
