import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
import type { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { AtSignIcon, PlusIcon, Settings } from "lucide-react"
import type React from "react"
import { useCallback, useMemo, useState } from "react"
import styled from "styled-components"
import { getModeSpecificFields, normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/services/grpcClient"
import { useMetaKeyDetection, useShortcut } from "@/utils/hooks"
import ClineRulesToggleModal from "../clineRules/ClineRulesToggleModal"
import ServersToggleModal from "./ServersToggleModal"

const SwitchContainer = styled.div<{ disabled: boolean }>`
	display: flex;
	align-items: center;
	background-color: transparent;
	border: 1px solid var(--vscode-input-border);
	border-radius: 12px;
	overflow: hidden;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	transform: scale(1);
	transform-origin: right center;
	margin-left: 0;
	user-select: none;
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
`

const Slider = styled.div.withConfig({
	shouldForwardProp: (prop) => prop !== "isAct",
})<{ isAct: boolean }>`
	position: absolute;
	height: 100%;
	width: 50%;
	background-color: var(--lig-mode-active-background);
	box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
	transition: transform 0.2s ease;
	transform: translateX(${(props) => (props.isAct ? "100%" : "0%")});
`

const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
	flex: 1;
	min-width: 0;
`

const ButtonContainer = styled.div`
	display: flex;
	align-items: center;
	gap: 3px;
	font-size: 10px;
	white-space: nowrap;
	min-width: 0;
	width: 100%;
`

const ModelContainer = styled.div`
	position: relative;
	display: flex;
	flex: 1;
	min-width: 0;
`

const ModelTextWrapper = styled.div`
	display: inline-flex;
	min-width: 0;
	max-width: 100%;
`

const ModelDisplayText = styled.span`
	height: 20px;
	width: 100%;
	min-width: 0;
	color: var(--vscode-descriptionForeground);
	display: flex;
	align-items: center;
	font-size: 10px;
	user-select: none;
`

const ModelButtonContent = styled.div`
	width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

interface ChatInputToolbarProps {
	inputValue: string
	selectedFiles: string[]
	selectedImages: string[]
	setInputValue: (value: string) => void
	onAddContext: () => void
	onSelectFilesAndImages: () => void
	shouldDisableFilesAndImages: boolean
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>
}

function getModelDisplayName(apiConfiguration: ReturnType<typeof useExtensionState>["apiConfiguration"], mode: Mode) {
	const { selectedProvider, selectedModelId } = normalizeApiConfiguration(apiConfiguration, mode)
	const {
		vsCodeLmModelSelector,
		togetherModelId,
		lmStudioModelId,
		ollamaModelId,
		liteLlmModelId,
		requestyModelId,
		vercelAiGatewayModelId,
	} = getModeSpecificFields(apiConfiguration, mode)
	const unknownModel = "unknown"
	if (!apiConfiguration) {
		return unknownModel
	}
	switch (selectedProvider) {
		case "cline":
			return `${selectedProvider}:${selectedModelId}`
		case "openai":
			return `openai-compat:${selectedModelId}`
		case "vscode-lm":
			return `vscode-lm:${vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor ?? ""}/${vsCodeLmModelSelector.family ?? ""}` : unknownModel}`
		case "together":
			return `${selectedProvider}:${togetherModelId}`
		case "lmstudio":
			return `${selectedProvider}:${lmStudioModelId}`
		case "ollama":
			return `${selectedProvider}:${ollamaModelId}`
		case "litellm":
			return `${selectedProvider}:${liteLlmModelId}`
		case "requesty":
			return `${selectedProvider}:${requestyModelId}`
		case "vercel-ai-gateway":
			return `${selectedProvider}:${vercelAiGatewayModelId || selectedModelId}`
		default:
			return `${selectedProvider}:${selectedModelId}`
	}
}

export default function ChatInputToolbar({
	inputValue,
	selectedFiles,
	selectedImages,
	setInputValue,
	onAddContext,
	onSelectFilesAndImages,
	shouldDisableFilesAndImages,
	textAreaRef,
}: ChatInputToolbarProps) {
	const { apiConfiguration, mode, navigateToSettings, platform } = useExtensionState()
	const { t } = useI18n()
	const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)
	const [, metaKeyChar] = useMetaKeyDetection(platform)
	const platformContext = usePlatform()
	const modelDisplayName = useMemo(
		() => getModelDisplayName(apiConfiguration, mode),
		[apiConfiguration, mode],
	)

	const onModeToggle = useCallback(() => {
		void (async () => {
			const response = await StateServiceClient.togglePlanActModeProto(
				TogglePlanActModeRequest.create({
					mode: mode === "plan" ? PlanActMode.ACT : PlanActMode.PLAN,
					chatContent: {
						message: inputValue.trim() ? inputValue : undefined,
						images: selectedImages,
						files: selectedFiles,
					},
				}),
			)
			setTimeout(() => {
				if (response.value) {
					setInputValue("")
				}
				textAreaRef.current?.focus()
			}, 100)
		})()
	}, [inputValue, mode, selectedFiles, selectedImages, setInputValue, textAreaRef])

	useShortcut(platformContext.togglePlanActKeys, onModeToggle, { disableTextInputs: false })
	const togglePlanActKeys = platformContext.togglePlanActKeys
		.replace("Meta", metaKeyChar)
		.replace(/.$/, (match) => match.toUpperCase())

	return (
		<div className="lig-input-toolbar flex justify-between items-center mt-1.5">
			<div className="relative flex-1 min-w-0 h-5">
				<ButtonGroup className="absolute top-0 left-0 right-0 ease-in-out w-full h-5 z-10 flex items-center">
					<Tooltip>
						<TooltipContent>{t("chat.addContext")}</TooltipContent>
						<TooltipTrigger>
							<VSCodeButton appearance="icon" aria-label={t("chat.addContext")} className="p-0 m-0 flex items-center" data-testid="context-button" onClick={onAddContext}>
								<ButtonContainer><AtSignIcon size={12} /></ButtonContainer>
							</VSCodeButton>
						</TooltipTrigger>
					</Tooltip>
					<Tooltip>
						<TooltipContent>{t("chat.addFilesImages")}</TooltipContent>
						<TooltipTrigger>
							<VSCodeButton
								appearance="icon"
								aria-label={t("chat.addFilesImages")}
								className="p-0 m-0 flex items-center"
								data-testid="files-button"
								disabled={shouldDisableFilesAndImages}
								onClick={() => !shouldDisableFilesAndImages && onSelectFilesAndImages()}>
								<ButtonContainer><PlusIcon size={13} /></ButtonContainer>
							</VSCodeButton>
						</TooltipTrigger>
					</Tooltip>
					<ServersToggleModal />
					<ClineRulesToggleModal />
					<ModelContainer>
						<ModelTextWrapper>
							<ModelDisplayText title={modelDisplayName}>
								<ModelButtonContent className="text-xs">{modelDisplayName}</ModelButtonContent>
							</ModelDisplayText>
						</ModelTextWrapper>
					</ModelContainer>
				</ButtonGroup>
			</div>
			<Tooltip>
				<TooltipContent>{t("common.settings")}</TooltipContent>
				<TooltipTrigger>
					<VSCodeButton appearance="icon" aria-label={t("common.settings")} className="p-0 m-0 mr-1 shrink-0 flex items-center" data-testid="settings-button" onClick={() => navigateToSettings()}>
						<ButtonContainer><Settings size={13} /></ButtonContainer>
					</VSCodeButton>
				</TooltipTrigger>
			</Tooltip>
			<Tooltip>
				<TooltipContent className="text-xs px-2 flex flex-col gap-1" hidden={shownTooltipMode === null} side="top">
					{shownTooltipMode === "act" ? t("chat.actModeTooltip") : t("chat.planModeTooltip")}
					<p className="text-description/80 text-xs mb-0">
						{t("chat.toggleWith", { keys: "" })}<kbd className="text-muted-foreground mx-1">{togglePlanActKeys}</kbd>
					</p>
				</TooltipContent>
				<TooltipTrigger>
					<SwitchContainer data-testid="mode-switch" disabled={false}>
						<Slider isAct={mode === "act"} />
						{(["plan", "act"] as const).map((itemMode) => (
							<button
								aria-label={t(mode === itemMode ? "chat.modeActive" : "chat.modeInactive", { mode: itemMode === "plan" ? t("chat.plan") : t("chat.act") })}
								aria-pressed={mode === itemMode}
								className={cn("pt-0.5 pb-px px-2 z-10 text-xs w-1/2 text-center bg-transparent border-0 cursor-pointer transition-colors", mode === itemMode ? "text-(--lig-mode-active-foreground) font-semibold" : "text-input-foreground")}
								key={itemMode}
								onBlur={() => setShownTooltipMode(null)}
								onClick={onModeToggle}
								onFocus={() => setShownTooltipMode(itemMode)}
								onMouseLeave={() => setShownTooltipMode(null)}
								onMouseOver={() => setShownTooltipMode(itemMode)}
								type="button">
								{itemMode === "plan" ? t("chat.plan") : t("chat.act")}
							</button>
						))}
					</SwitchContainer>
				</TooltipTrigger>
			</Tooltip>
		</div>
	)
}
