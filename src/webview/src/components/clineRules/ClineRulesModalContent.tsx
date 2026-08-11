import { VSCodeLink } from "@vscode/webview-ui-toolkit/react";
import HookRow from "./HookRow";
import NewRuleRow from "./NewRuleRow";
import RuleRow from "./RuleRow";
import RulesToggleList from "./RulesToggleList";
import type { useClineRulesToggleModalController } from "./useClineRulesToggleModalController";

type Controller = ReturnType<typeof useClineRulesToggleModalController>;

export function ClineRulesModalContent({
	controller,
}: {
	controller: Controller;
}) {
	const {
		currentView,
		hasAnyRules,
		t,
		hasRemoteRules,
		remoteGlobalRules,
		remoteRulesToggles,
		toggleRemoteRule,
		globalRules,
		toggleRule,
		localRules,
		cursorRules,
		toggleCursorRule,
		windsurfRules,
		toggleWindsurfRule,
		agentsRules,
		toggleAgentsRule,
		hasAnyWorkflows,
		hasRemoteWorkflows,
		remoteGlobalWorkflows,
		remoteWorkflowToggles,
		toggleRemoteWorkflow,
		globalWorkflows,
		toggleWorkflow,
		localWorkflows,
		isWindows,
		globalHooks,
		setGlobalHooks,
		setWorkspaceHooks,
		toggleHook,
		workspaceHooks,
		globalSkills,
		toggleSkill,
		localSkills,
	} = controller;

	return (
		<div className="flex-1 overflow-y-auto px-3 pb-3" style={{ minHeight: 0 }}>
			{currentView === "rules" ? (
				<>
					{!hasAnyRules && (
						<div className="mb-3 rounded-sm border border-(--vscode-panel-border) px-3 py-2 text-xs text-description">
							{t("rules.emptyRules")}
						</div>
					)}
					{/* Remote Rules Section */}
					{hasRemoteRules && (
						<div className="mb-3">
							<div className="text-sm font-normal mb-2">
								{t("rules.enterpriseRules")}
							</div>
							<div className="flex flex-col gap-0">
								{remoteGlobalRules.map((rule) => {
									const enabled =
										rule.alwaysEnabled ||
										remoteRulesToggles[rule.name] === true;
									return (
										<RuleRow
											alwaysEnabled={rule.alwaysEnabled}
											enabled={enabled}
											isGlobal={false}
											isRemote={true}
											key={rule.name}
											rulePath={rule.name}
											ruleType="cline"
											toggleRule={toggleRemoteRule}
										/>
									);
								})}
							</div>
						</div>
					)}

					{/* Global Rules Section */}
					<div className="mb-3">
						<div className="text-sm font-normal mb-2">
							{t("rules.globalRules")}
						</div>

						{/* File-based Global Rules */}
						<RulesToggleList
							isGlobal={true}
							listGap="small"
							rules={globalRules}
							ruleType={"cline"}
							showNewRule={true}
							showNoRules={false}
							toggleRule={(rulePath, enabled) =>
								toggleRule(true, rulePath, enabled)
							}
						/>
					</div>

					{/* Local Rules Section */}
					<div className="-mb-2.5">
						<div className="text-sm font-normal mb-2">
							{t("rules.workspaceRules")}
						</div>
						<RulesToggleList
							isGlobal={false}
							listGap="small"
							rules={localRules}
							ruleType={"cline"}
							showNewRule={false}
							showNoRules={false}
							toggleRule={(rulePath, enabled) =>
								toggleRule(false, rulePath, enabled)
							}
						/>

						<RulesToggleList
							isGlobal={false}
							listGap="small"
							rules={cursorRules}
							ruleType={"cursor"}
							showNewRule={false}
							showNoRules={false}
							toggleRule={toggleCursorRule}
						/>
						<RulesToggleList
							isGlobal={false}
							listGap="small"
							rules={windsurfRules}
							ruleType={"windsurf"}
							showNewRule={false}
							showNoRules={false}
							toggleRule={toggleWindsurfRule}
						/>
						<RulesToggleList
							isGlobal={false}
							listGap="small"
							rules={agentsRules}
							ruleType={"agents"}
							showNewRule={false}
							showNoRules={false}
							toggleRule={toggleAgentsRule}
						/>
					</div>
				</>
			) : currentView === "workflows" ? (
				<>
					{!hasAnyWorkflows && (
						<div className="mb-3 rounded-sm border border-(--vscode-panel-border) px-3 py-2 text-xs text-description">
							{t("rules.emptyWorkflows")}
						</div>
					)}
					{/* Remote Workflows Section */}
					{hasRemoteWorkflows && (
						<div className="mb-3">
							<div className="text-sm font-normal mb-2">
								{t("rules.enterpriseWorkflows")}
							</div>
							<div className="flex flex-col gap-0">
								{remoteGlobalWorkflows.map((workflow) => {
									const enabled =
										workflow.alwaysEnabled ||
										remoteWorkflowToggles[workflow.name] === true;
									return (
										<RuleRow
											alwaysEnabled={workflow.alwaysEnabled}
											enabled={enabled}
											isGlobal={false}
											isRemote={true}
											key={workflow.name}
											rulePath={workflow.name}
											ruleType="workflow"
											toggleRule={toggleRemoteWorkflow}
										/>
									);
								})}
							</div>
						</div>
					)}

					{/* Global Workflows Section */}
					<div className="mb-3">
						<div className="text-sm font-normal mb-2">
							{t("rules.globalWorkflows")}
						</div>

						{/* File-based Global Workflows */}
						<RulesToggleList
							isGlobal={true}
							listGap="small"
							rules={globalWorkflows}
							ruleType={"workflow"}
							showNewRule={true}
							showNoRules={false}
							toggleRule={(rulePath, enabled) =>
								toggleWorkflow(true, rulePath, enabled)
							}
						/>
					</div>

					{/* Local Workflows Section */}
					<div className="-mb-2.5">
						<div className="text-sm font-normal mb-2">
							{t("rules.workspaceWorkflows")}
						</div>
						<RulesToggleList
							isGlobal={false}
							listGap="small"
							rules={localWorkflows}
							ruleType={"workflow"}
							showNewRule={true}
							showNoRules={false}
							toggleRule={(rulePath, enabled) =>
								toggleWorkflow(false, rulePath, enabled)
							}
						/>
					</div>
				</>
			) : currentView === "hooks" ? (
				<>
					<div className="text-xs text-description mb-4">
						<p>
							{isWindows ? t("rules.hooksWindows") : t("rules.hooksUnix")}{" "}
							<VSCodeLink
								className="text-xs"
								href="https://docs.cline.bot/features/hooks"
								style={{ display: "inline", fontSize: "inherit" }}
							>
								{t("rules.docs")}
							</VSCodeLink>
						</p>
					</div>
					{/* Hooks Tab */}
					<div className="flex items-center gap-2 px-3 py-3 mb-4 bg-vscode-textBlockQuote-background border-l-[3px] border-vscode-textBlockQuote-border">
						<i className="codicon codicon-symbol-event text-sm" />
						<span className="text-base">
							{t("rules.hooksInfo")}{" "}
							<code>{'{"decision":"block","reason":"..." }'}</code>.
						</span>
					</div>

					{/* Global Hooks */}
					<div className="mb-3">
						<div className="text-sm font-normal mb-2">
							{t("rules.globalHooks")}
						</div>
						<div className="flex flex-col gap-0">
							{globalHooks
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((hook) => (
									<HookRow
										absolutePath={hook.absolutePath}
										enabled={hook.enabled}
										hookName={hook.name}
										isGlobal={true}
										key={hook.name}
										onDelete={(hooksToggles) => {
											// Use response data directly, no need to refresh
											setGlobalHooks(hooksToggles.globalHooks || []);
											setWorkspaceHooks(hooksToggles.workspaceHooks || []);
										}}
										onToggle={(name: string, newEnabled: boolean) =>
											toggleHook(true, name, newEnabled)
										}
									/>
								))}
							<NewRuleRow
								existingHooks={globalHooks.map((h) => h.name)}
								isGlobal={true}
								ruleType="hook"
							/>
						</div>
					</div>

					{/* Workspace Hooks - one section per workspace */}
					{workspaceHooks.map((workspace, index) => (
						<div
							className={
								index === workspaceHooks.length - 1 ? "-mb-2.5" : "mb-3"
							}
							key={workspace.workspaceName}
						>
							<div className="text-sm font-normal mb-2">
								{workspace.workspaceName}/.clinerules/hooks/
							</div>
							<div className="flex flex-col gap-0">
								{workspace.hooks
									.sort((a, b) => a.name.localeCompare(b.name))
									.map((hook) => (
										<HookRow
											absolutePath={hook.absolutePath}
											enabled={hook.enabled}
											hookName={hook.name}
											isGlobal={false}
											key={hook.absolutePath}
											onDelete={(hooksToggles) => {
												// Use response data directly, no need to refresh
												setGlobalHooks(hooksToggles.globalHooks || []);
												setWorkspaceHooks(hooksToggles.workspaceHooks || []);
											}}
											onToggle={(name: string, newEnabled: boolean) =>
												toggleHook(
													false,
													name,
													newEnabled,
													workspace.workspaceName,
												)
											}
											workspaceName={workspace.workspaceName}
										/>
									))}
								<NewRuleRow
									existingHooks={workspace.hooks.map((h) => h.name)}
									isGlobal={false}
									ruleType="hook"
									workspaceName={workspace.workspaceName}
								/>
							</div>
						</div>
					))}
				</>
			) : currentView === "skills" ? (
				<>
					{/* Enterprise Skills Section (remote) */}
					{globalSkills.some((s) => s.path.startsWith("remote:")) && (
						<div className="mb-3">
							<div className="text-sm font-normal mb-2">
								{t("rules.enterpriseSkills")}
							</div>
							<div className="flex flex-col gap-0">
								{globalSkills
									.filter((s) => s.path.startsWith("remote:"))
									.sort((a, b) => a.name.localeCompare(b.name))
									.map((skill) => (
										<RuleRow
											alwaysEnabled={skill.alwaysEnabled}
											enabled={skill.enabled}
											isGlobal={true}
											isRemote={true}
											key={skill.path}
											rulePath={skill.name}
											ruleType="skill"
											toggleRule={(_path, enabled) =>
												toggleSkill(true, skill.path, enabled)
											}
										/>
									))}
							</div>
						</div>
					)}

					{/* Global Skills Section */}
					<div className="mb-3">
						<div className="text-sm font-normal mb-2">
							{t("rules.globalSkills")}
						</div>
						<div className="flex flex-col gap-0">
							{globalSkills
								.filter((s) => !s.path.startsWith("remote:"))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((skill) => (
									<RuleRow
										enabled={skill.enabled}
										isGlobal={true}
										key={skill.path}
										rulePath={skill.path}
										ruleType="skill"
										toggleRule={(_path, enabled) =>
											toggleSkill(true, skill.path, enabled)
										}
									/>
								))}
							<NewRuleRow isGlobal={true} ruleType="skill" />
						</div>
					</div>

					{/* Workspace Skills Section */}
					<div className="-mb-2.5">
						<div className="text-sm font-normal mb-2">
							{t("rules.workspaceSkills")}
						</div>
						<div className="flex flex-col gap-0">
							{localSkills
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((skill) => (
									<RuleRow
										enabled={skill.enabled}
										isGlobal={false}
										key={skill.path}
										rulePath={skill.path}
										ruleType="skill"
										toggleRule={(path, enabled) =>
											toggleSkill(false, path, enabled)
										}
									/>
								))}
							<NewRuleRow isGlobal={false} ruleType="skill" />
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}
