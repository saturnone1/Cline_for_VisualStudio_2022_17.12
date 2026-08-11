import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react";
import React from "react";
import styled from "styled-components";
import PopupModalContainer from "@/components/common/PopupModalContainer";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { ClineRulesModalContent } from "./ClineRulesModalContent";
import { useClineRulesToggleModalController } from "./useClineRulesToggleModalController";

const ClineRulesToggleModal: React.FC = () => {
	const controller = useClineRulesToggleModalController();
	const {
		remoteRulesToggles,
		remoteWorkflowToggles,
		hooksEnabled,
		t,
		globalHooks,
		setGlobalHooks,
		workspaceHooks,
		setWorkspaceHooks,
		globalSkills,
		localSkills,
		isWindows,
		isVisible,
		setIsVisible,
		buttonRef,
		modalRef,
		arrowPosition,
		menuPosition,
		currentView,
		setCurrentView,
		globalRules,
		localRules,
		cursorRules,
		windsurfRules,
		agentsRules,
		localWorkflows,
		globalWorkflows,
		remoteGlobalRules,
		remoteGlobalWorkflows,
		hasRemoteRules,
		hasRemoteWorkflows,
		hasAnyRules,
		hasAnyWorkflows,
		toggleRule,
		toggleCursorRule,
		toggleWindsurfRule,
		toggleAgentsRule,
		toggleHook,
		toggleWorkflow,
		toggleRemoteRule,
		toggleRemoteWorkflow,
		toggleSkill,
	} = controller;

	return (
		<div className="inline-flex min-w-0 max-w-full items-center" ref={modalRef}>
			<div className="inline-flex w-full items-center" ref={buttonRef}>
				<Tooltip>
					{!isVisible && <TooltipContent>{t("rules.manage")}</TooltipContent>}
					<TooltipTrigger>
						<VSCodeButton
							appearance="icon"
							aria-label={isVisible ? t("rules.hide") : t("rules.show")}
							className="p-0 m-0 flex items-center"
							onClick={() => setIsVisible(!isVisible)}
						>
							<i
								className="codicon codicon-law"
								style={{ fontSize: "12.5px" }}
							/>
						</VSCodeButton>
					</TooltipTrigger>
				</Tooltip>
			</div>

			{isVisible && (
				<PopupModalContainer
					$arrowPosition={arrowPosition}
					$menuPosition={menuPosition}
				>
					{/* Fixed header section - tabs and description */}
					<div className="flex-shrink-0 px-3 pt-2">
						{/* Tabs container */}
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								marginBottom: "10px",
								overflow: "hidden",
							}}
						>
							<div
								style={{
									display: "flex",
									gap: "1px",
									borderBottom: "1px solid var(--vscode-panel-border)",
									flexWrap: "wrap",
								}}
							>
								<TabButton
									isActive={currentView === "rules"}
									onClick={() => setCurrentView("rules")}
								>
									{t("rules.tab.rules")}
								</TabButton>
								<TabButton
									isActive={currentView === "workflows"}
									onClick={() => setCurrentView("workflows")}
								>
									{t("rules.tab.workflows")}
								</TabButton>
								{hooksEnabled && (
									<TabButton
										isActive={currentView === "hooks"}
										onClick={() => setCurrentView("hooks")}
									>
										{t("rules.tab.hooks")}
									</TabButton>
								)}
								<TabButton
									isActive={currentView === "skills"}
									onClick={() => setCurrentView("skills")}
								>
									{t("rules.tab.skills")}
								</TabButton>
							</div>
						</div>

						{/* Remote config banner */}
						{(currentView === "rules" && hasRemoteRules) ||
						(currentView === "workflows" && hasRemoteWorkflows) ? (
							<div className="flex items-center gap-2 px-3 py-3 mb-4 bg-vscode-textBlockQuote-background border-l-[3px] border-vscode-textLink-foreground">
								<i className="codicon codicon-lock text-sm" />
								<span className="text-base">
									{currentView === "rules"
										? t("rules.remoteRulesManaged")
										: t("rules.remoteWorkflowsManaged")}
								</span>
							</div>
						) : null}

						{/* Description text */}
						<div className="text-xs text-description mb-4">
							{currentView === "rules" ? (
								<p>
									{t("rules.description.rules")}{" "}
									<VSCodeLink
										className="text-xs"
										href="https://docs.cline.bot/features/cline-rules"
										style={{ display: "inline", fontSize: "inherit" }}
									>
										{t("rules.docs")}
									</VSCodeLink>
								</p>
							) : currentView === "workflows" ? (
								<p>
									{t("rules.description.workflows")}{" "}
									<span className="text-foreground font-bold">
										/workflow-name
									</span>
									<VSCodeLink
										className="text-xs inline"
										href="https://docs.cline.bot/features/slash-commands/workflows"
									>
										{t("rules.docs")}
									</VSCodeLink>
								</p>
							) : currentView === "skills" ? (
								<p>{t("rules.description.skills")}</p>
							) : (
								<p>{t("rules.description.hooks")}</p>
							)}
						</div>
					</div>

					<ClineRulesModalContent controller={controller} />
				</PopupModalContainer>
			)}
		</div>
	);
};

const StyledTabButton = styled.button<{ isActive: boolean }>`
	background: none;
	border: none;
	border-bottom: 2px solid ${(props) => (props.isActive ? "var(--vscode-foreground)" : "transparent")};
	color: ${(props) => (props.isActive ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)")};
	padding: 8px 12px;
	cursor: pointer;
	font-size: 13px;
	margin-bottom: -1px;
	font-family: inherit;
	white-space: nowrap;

	&:hover {
		color: var(--vscode-foreground);
	}
`;

export const TabButton = ({
	children,
	isActive,
	onClick,
}: {
	children: React.ReactNode;
	isActive: boolean;
	onClick: () => void;
}) => (
	<StyledTabButton
		aria-pressed={isActive}
		isActive={isActive}
		onClick={onClick}
	>
		{children}
	</StyledTabButton>
);

export default ClineRulesToggleModal;
