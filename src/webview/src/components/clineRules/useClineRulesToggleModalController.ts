import { EmptyRequest } from "@shared/proto/cline/common";
import {
	ClineRulesToggles,
	RefreshedRules,
	RuleScope,
	SkillInfo,
	ToggleAgentsRuleRequest,
	ToggleClineRuleRequest,
	ToggleCursorRuleRequest,
	ToggleSkillRequest,
	ToggleWindsurfRuleRequest,
	ToggleWorkflowRequest,
} from "@shared/proto/cline/file";
import { useEffect, useRef, useState } from "react";
import { useClickAway, useWindowSize } from "react-use";
import { useExtensionState } from "@/context/ExtensionStateContext";
import { useI18n } from "@/i18n";
import { FileServiceClient } from "@/services/grpcClient";
import { isMacOSOrLinux } from "@/utils/platformUtils";

export function useClineRulesToggleModalController() {
	const {
		globalClineRulesToggles = {},
		localClineRulesToggles = {},
		localCursorRulesToggles = {},
		localWindsurfRulesToggles = {},
		localAgentsRulesToggles = {},
		localWorkflowToggles = {},
		globalWorkflowToggles = {},
		globalSkillsToggles = {},
		localSkillsToggles = {},
		remoteRulesToggles = {},
		remoteWorkflowToggles = {},
		remoteConfigSettings = {},
		hooksEnabled,
		setGlobalClineRulesToggles,
		setLocalClineRulesToggles,
		setLocalCursorRulesToggles,
		setLocalWindsurfRulesToggles,
		setLocalAgentsRulesToggles,
		setLocalWorkflowToggles,
		setGlobalWorkflowToggles,
		setGlobalSkillsToggles,
		setLocalSkillsToggles,
		setRemoteRulesToggles,
		setRemoteWorkflowToggles,
	} = useExtensionState();
	const { t } = useI18n();
	const [globalHooks, setGlobalHooks] = useState<
		Array<{ name: string; enabled: boolean; absolutePath: string }>
	>([]);
	const [workspaceHooks, setWorkspaceHooks] = useState<
		Array<{
			workspaceName: string;
			hooks: Array<{ name: string; enabled: boolean; absolutePath: string }>;
		}>
	>([]);
	const [globalSkills, setGlobalSkills] = useState<SkillInfo[]>([]);
	const [localSkills, setLocalSkills] = useState<SkillInfo[]>([]);

	const isWindows = !isMacOSOrLinux();
	const [isVisible, setIsVisible] = useState(false);
	const buttonRef = useRef<HTMLDivElement>(null);
	const modalRef = useRef<HTMLDivElement>(null);
	const { width: viewportWidth, height: viewportHeight } = useWindowSize();
	const [arrowPosition, setArrowPosition] = useState(0);
	const [menuPosition, setMenuPosition] = useState(0);
	const [currentView, setCurrentView] = useState<
		"rules" | "workflows" | "hooks" | "skills"
	>("rules");

	// Auto-switch to rules tab if hooks become disabled while viewing hooks tab
	useEffect(() => {
		if (currentView === "hooks" && !hooksEnabled) {
			setCurrentView("rules");
		}
	}, [currentView, hooksEnabled]);

	useEffect(() => {
		if (isVisible) {
			FileServiceClient.refreshRules({} as EmptyRequest)
				.then((response: RefreshedRules) => {
					// Update state with the response data using all available setters
					if (response.globalClineRulesToggles?.toggles) {
						setGlobalClineRulesToggles(
							response.globalClineRulesToggles.toggles,
						);
					}
					if (response.localClineRulesToggles?.toggles) {
						setLocalClineRulesToggles(response.localClineRulesToggles.toggles);
					}
					if (response.localCursorRulesToggles?.toggles) {
						setLocalCursorRulesToggles(
							response.localCursorRulesToggles.toggles,
						);
					}
					if (response.localWindsurfRulesToggles?.toggles) {
						setLocalWindsurfRulesToggles(
							response.localWindsurfRulesToggles.toggles,
						);
					}
					if (response.localAgentsRulesToggles?.toggles) {
						setLocalAgentsRulesToggles(
							response.localAgentsRulesToggles.toggles,
						);
					}
					if (response.localWorkflowToggles?.toggles) {
						setLocalWorkflowToggles(response.localWorkflowToggles.toggles);
					}
					if (response.globalWorkflowToggles?.toggles) {
						setGlobalWorkflowToggles(response.globalWorkflowToggles.toggles);
					}
				})
				.catch((error) => {
					console.error("Failed to refresh rules:", error);
				});
		}
	}, [
		isVisible,
		setGlobalClineRulesToggles,
		setLocalClineRulesToggles,
		setGlobalWorkflowToggles,
		setLocalCursorRulesToggles,
		setLocalWindsurfRulesToggles,
		setLocalWorkflowToggles,
	]);

	// Refresh hooks when hooks tab becomes visible
	useEffect(() => {
		if (!isVisible || currentView !== "hooks") {
			return;
		}

		const abortController = new AbortController();

		// Initial refresh when tab opens
		const refreshHooks = () => {
			if (abortController.signal.aborted) return;

			FileServiceClient.refreshHooks({} as EmptyRequest)
				.then((response) => {
					if (!abortController.signal.aborted) {
						setGlobalHooks(response.globalHooks || []);
						setWorkspaceHooks(response.workspaceHooks || []);
					}
				})
				.catch((error) => {
					if (!abortController.signal.aborted) {
						console.error("Failed to refresh hooks:", error);
					}
				});
		};

		// Refresh immediately
		refreshHooks();

		// Keep filesystem-backed hooks fresh without hammering the host bridge.
		const pollInterval = setInterval(refreshHooks, 10000);

		return () => {
			abortController.abort();
			clearInterval(pollInterval);
		};
	}, [isVisible, currentView]);

	// Refresh skills when skills tab becomes visible
	useEffect(() => {
		if (!isVisible || currentView !== "skills") {
			return;
		}

		let isCancelled = false;

		const refreshSkills = () => {
			if (isCancelled) return;

			FileServiceClient.refreshSkills({} as EmptyRequest)
				.then((response) => {
					if (!isCancelled) {
						setGlobalSkills(response.globalSkills || []);
						setLocalSkills(response.localSkills || []);
					}
				})
				.catch((error) => {
					if (!isCancelled) {
						console.error("Failed to refresh skills:", error);
					}
				});
		};

		// Refresh immediately
		refreshSkills();

		// Keep filesystem-backed skills fresh without hammering the host bridge.
		const pollInterval = setInterval(refreshSkills, 10000);

		return () => {
			isCancelled = true;
			clearInterval(pollInterval);
		};
	}, [isVisible, currentView]);

	// Format global rules for display with proper typing
	const globalRules = Object.entries(globalClineRulesToggles || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b));

	// Format local rules for display with proper typing
	const localRules = Object.entries(localClineRulesToggles || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b));

	const cursorRules = Object.entries(localCursorRulesToggles || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b));

	const windsurfRules = Object.entries(localWindsurfRulesToggles || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b));

	const agentsRules = Object.entries(localAgentsRulesToggles || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b));

	const localWorkflows = Object.entries(localWorkflowToggles || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b));

	const globalWorkflows = Object.entries(globalWorkflowToggles || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b));

	// Get remote rules and workflows from remote config
	const remoteGlobalRules = remoteConfigSettings.remoteGlobalRules || [];
	const remoteGlobalWorkflows =
		remoteConfigSettings.remoteGlobalWorkflows || [];

	// Check if we have any remote rules or workflows
	const hasRemoteRules = remoteGlobalRules.length > 0;
	const hasRemoteWorkflows = remoteGlobalWorkflows.length > 0;
	const hasAnyRules =
		hasRemoteRules ||
		globalRules.length > 0 ||
		localRules.length > 0 ||
		cursorRules.length > 0 ||
		windsurfRules.length > 0 ||
		agentsRules.length > 0;
	const hasAnyWorkflows =
		hasRemoteWorkflows ||
		globalWorkflows.length > 0 ||
		localWorkflows.length > 0;

	// Handle toggle rule using gRPC
	const toggleRule = (
		isGlobal: boolean,
		rulePath: string,
		enabled: boolean,
	) => {
		FileServiceClient.toggleClineRule(
			ToggleClineRuleRequest.create({
				scope: isGlobal ? RuleScope.GLOBAL : RuleScope.LOCAL,
				rulePath,
				enabled,
			}),
		)
			.then((response) => {
				// Update the local state with the response
				if (response.globalClineRulesToggles?.toggles) {
					setGlobalClineRulesToggles(response.globalClineRulesToggles.toggles);
				}
				if (response.localClineRulesToggles?.toggles) {
					setLocalClineRulesToggles(response.localClineRulesToggles.toggles);
				}
				if (response.remoteRulesToggles?.toggles) {
					setRemoteRulesToggles(response.remoteRulesToggles.toggles);
				}
			})
			.catch((error) => {
				console.error("Error toggling Cline rule:", error);
			});
	};

	const toggleCursorRule = (rulePath: string, enabled: boolean) => {
		FileServiceClient.toggleCursorRule(
			ToggleCursorRuleRequest.create({
				rulePath,
				enabled,
			}),
		)
			.then((response) => {
				// Update the local state with the response
				if (response.toggles) {
					setLocalCursorRulesToggles(response.toggles);
				}
			})
			.catch((error) => {
				console.error("Error toggling Cursor rule:", error);
			});
	};

	const toggleWindsurfRule = (rulePath: string, enabled: boolean) => {
		FileServiceClient.toggleWindsurfRule(
			ToggleWindsurfRuleRequest.create({
				rulePath,
				enabled,
			} as ToggleWindsurfRuleRequest),
		)
			.then((response: ClineRulesToggles) => {
				if (response.toggles) {
					setLocalWindsurfRulesToggles(response.toggles);
				}
			})
			.catch((error) => {
				console.error("Error toggling Windsurf rule:", error);
			});
	};

	const toggleAgentsRule = (rulePath: string, enabled: boolean) => {
		FileServiceClient.toggleAgentsRule(
			ToggleAgentsRuleRequest.create({
				rulePath,
				enabled,
			} as ToggleAgentsRuleRequest),
		)
			.then((response: ClineRulesToggles) => {
				if (response.toggles) {
					setLocalAgentsRulesToggles(response.toggles);
				}
			})
			.catch((error) => {
				console.error("Error toggling Agents rule:", error);
			});
	};

	// Toggle hook handler
	const toggleHook = (
		isGlobal: boolean,
		hookName: string,
		enabled: boolean,
		workspaceName?: string,
	) => {
		FileServiceClient.toggleHook({
			metadata: {} as any,
			hookName,
			isGlobal,
			enabled,
			workspaceName,
		})
			.then((response) => {
				setGlobalHooks(response.hooksToggles?.globalHooks || []);
				setWorkspaceHooks(response.hooksToggles?.workspaceHooks || []);
			})
			.catch((error) => {
				console.error("Error toggling hook:", error);
			});
	};

	const toggleWorkflow = (
		isGlobal: boolean,
		workflowPath: string,
		enabled: boolean,
	) => {
		FileServiceClient.toggleWorkflow(
			ToggleWorkflowRequest.create({
				workflowPath,
				enabled,
				scope: isGlobal ? RuleScope.GLOBAL : RuleScope.LOCAL,
			}),
		)
			.then((response) => {
				if (response.toggles) {
					if (isGlobal) {
						setGlobalWorkflowToggles(response.toggles);
					} else {
						setLocalWorkflowToggles(response.toggles);
					}
				}
			})
			.catch((err: Error) => {
				console.error("Failed to toggle workflow:", err);
			});
	};

	// Handle toggle for remote rules
	const toggleRemoteRule = (ruleName: string, enabled: boolean) => {
		FileServiceClient.toggleClineRule(
			ToggleClineRuleRequest.create({
				scope: RuleScope.REMOTE,
				rulePath: ruleName,
				enabled,
			}),
		)
			.then((response) => {
				// Update the local state with the response
				if (response.remoteRulesToggles?.toggles) {
					setRemoteRulesToggles(response.remoteRulesToggles.toggles);
				}
			})
			.catch((error) => {
				console.error("Error toggling remote rule:", error);
			});
	};

	// Handle toggle for remote workflows
	const toggleRemoteWorkflow = (workflowName: string, enabled: boolean) => {
		FileServiceClient.toggleWorkflow(
			ToggleWorkflowRequest.create({
				workflowPath: workflowName,
				enabled,
				scope: RuleScope.REMOTE,
			}),
		)
			.then((response) => {
				if (response.toggles) {
					setRemoteWorkflowToggles(response.toggles);
				}
			})
			.catch((error) => {
				console.error("Error toggling remote workflow:", error);
			});
	};

	// Handle toggle for skills
	const toggleSkill = (
		isGlobal: boolean,
		skillPath: string,
		enabled: boolean,
	) => {
		FileServiceClient.toggleSkill(
			ToggleSkillRequest.create({
				skillPath,
				isGlobal,
				enabled,
			}),
		)
			.then((response) => {
				if (response.globalSkillsToggles) {
					setGlobalSkillsToggles(response.globalSkillsToggles);
				}
				if (response.localSkillsToggles) {
					setLocalSkillsToggles(response.localSkillsToggles);
				}
				// Update local skills state
				if (skillPath.startsWith("remote:")) {
					setGlobalSkills((prev) =>
						prev.map((s) => (s.path === skillPath ? { ...s, enabled } : s)),
					);
				} else if (isGlobal) {
					setGlobalSkills((prev) =>
						prev.map((s) => (s.path === skillPath ? { ...s, enabled } : s)),
					);
				} else {
					setLocalSkills((prev) =>
						prev.map((s) => (s.path === skillPath ? { ...s, enabled } : s)),
					);
				}
			})
			.catch((error) => {
				console.error("Error toggling skill:", error);
			});
	};

	// Close modal when clicking outside
	useClickAway(modalRef, () => {
		setIsVisible(false);
	});

	// Calculate positions for modal and arrow
	useEffect(() => {
		if (isVisible && buttonRef.current) {
			const buttonRect = buttonRef.current.getBoundingClientRect();
			const buttonCenter = buttonRect.left + buttonRect.width / 2;
			const rightPosition =
				document.documentElement.clientWidth - buttonCenter - 5;

			setArrowPosition(rightPosition);
			setMenuPosition(buttonRect.top + 1);
		}
	}, [isVisible, viewportWidth, viewportHeight]);

	return {
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
	};
}
