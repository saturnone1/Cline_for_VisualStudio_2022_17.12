import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { memo, type ReactNode, useCallback } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import Section from "../Section"
import SettingsSlider from "../SettingsSlider"
import { updateSetting } from "../utils/settingsHandlers"

// Reusable checkbox component for feature settings
interface FeatureCheckboxProps {
	checked: boolean | undefined
	onChange: (checked: boolean) => void
	label: string
	switchId: string
	description: ReactNode
	disabled?: boolean
	isRemoteLocked?: boolean
	remoteTooltip?: string
	isVisible?: boolean
}

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
	/** If set, the setting value is nested with this key (e.g., "enabled" -> { enabled: checked }) */
	nestedKey?: string
}

const agentFeatures: FeatureToggle[] = [
	{
		id: "subagents",
		label: "Subagents",
		description: "Let LIG VS run focused subagents in parallel to explore the codebase for you.",
		stateKey: "subagentsEnabled",
		settingKey: "subagentsEnabled",
	},
	{
		id: "scheduled-agents",
		label: "Scheduled Agents",
		description: "Enable SDK workspace automation from local .cline/cron specs.",
		stateKey: "scheduledAgentsEnabled",
		settingKey: "scheduledAgentsEnabled",
	},
	{
		id: "native-tool-call",
		label: "Native Tool Call",
		description: "Use native function calling when available",
		stateKey: "nativeToolCallSetting",
		settingKey: "nativeToolCallEnabled",
	},
	{
		id: "parallel-tool-calling",
		label: "Parallel Tool Calling",
		description: "Execute multiple tool calls simultaneously",
		stateKey: "enableParallelToolCalling",
		settingKey: "enableParallelToolCalling",
	},
	{
		id: "strict-plan-mode",
		label: "Strict Plan Mode",
		description: "Prevents file edits while in Plan mode",
		stateKey: "strictPlanModeEnabled",
		settingKey: "strictPlanModeEnabled",
	},
	{
		id: "auto-compact",
		label: "Auto Compact (requires usage)",
		description: "Ask to compact when reliable context usage is available. Providers that do not report usage keep this unavailable.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
	},
	{
		id: "focus-chain",
		label: "Focus Chain",
		description: "Maintain context focus across interactions",
		stateKey: "focusChainEnabled",
		settingKey: "focusChainSettings",
		nestedKey: "enabled",
	},
]

const editorFeatures: FeatureToggle[] = [
	{
		id: "show-feature-tips",
		label: "Feature Tips",
		description: "Show rotating tips during the thinking phase to help you discover LIG VS features.",
		stateKey: "showFeatureTips",
		settingKey: "showFeatureTips",
	},
	{
		id: "background-edit",
		label: "Background Edit",
		description: "Allow edits without stealing editor focus",
		stateKey: "backgroundEditEnabled",
		settingKey: "backgroundEditEnabled",
	},
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
	},
	{
		id: "cline-web-tools",
		label: "LIG VS Web Tools",
		description: "Access web browsing and search capabilities",
		stateKey: "clineWebToolsEnabled",
		settingKey: "clineWebToolsEnabled",
	},
	{
		id: "worktrees",
		label: "Worktrees",
		description: "Enables git worktree management for running parallel LIG VS tasks.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
	},
]

const experimentalFeatures: FeatureToggle[] = [
	{
		id: "yolo",
		label: "Yolo Mode",
		description:
			"Execute tasks without user's confirmation. Auto-switches from Plan to Act mode and disables the ask question tool. Use with extreme caution.",
		stateKey: "yoloModeToggled",
		settingKey: "yoloModeToggled",
	},
	{
		id: "double-check-completion",
		label: "Double-Check Completion",
		description:
			"Rejects the first completion attempt and asks the model to re-verify its work against the original task requirements before accepting.",
		stateKey: "doubleCheckCompletionEnabled",
		settingKey: "doubleCheckCompletionEnabled",
	},
	{
		id: "lazy-teammate",
		label: "Lazy Teammate Mode",
		description: "Sometimes LIG VS just isn't feeling it today. For entertainment purposes only.",
		stateKey: "lazyTeammateModeEnabled",
		settingKey: "lazyTeammateModeEnabled",
	},
]

const advancedFeatures: FeatureToggle[] = [
	{
		id: "hooks",
		label: "Hooks",
		description: "Enable lifecycle and tool hooks during task execution.",
		stateKey: "hooksEnabled",
		settingKey: "hooksEnabled",
	},
]

const FeatureRow = memo(
	({
		checked = false,
		onChange,
		label,
		switchId,
		description,
		disabled,
		isRemoteLocked,
		isVisible = true,
		remoteTooltip,
	}: FeatureCheckboxProps) => {
		if (!isVisible) {
			return null
		}

		const checkbox = (
			<div className="flex items-center justify-between w-full">
				<div>{label}</div>
				<div>
					<Switch
						checked={checked}
						className="shrink-0"
						disabled={disabled || isRemoteLocked}
						id={switchId}
						onCheckedChange={onChange}
						size="lg"
					/>
					{isRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
				</div>
			</div>
		)

		return (
			<div className="flex flex-col items-start justify-between gap-4 py-3 w-full">
				<div className="space-y-0.5 flex-1 w-full">
					{isRemoteLocked ? (
						<Tooltip>
							<TooltipTrigger asChild>{checkbox}</TooltipTrigger>
							<TooltipContent className="max-w-xs" side="top">
								{remoteTooltip}
							</TooltipContent>
						</Tooltip>
					) : (
						checkbox
					)}
				</div>
				<div className="text-xs text-description">{description}</div>
			</div>
		)
	},
)

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const { language, t } = useI18n()
	const {
		enableCheckpointsSetting,
		hooksEnabled,
		mcpDisplayMode,
		strictPlanModeEnabled,
		yoloModeToggled,
		useAutoCondense,
		subagentsEnabled,
		scheduledAgentsEnabled,
		clineWebToolsEnabled,
		worktreesEnabled,
		focusChainSettings,
		remoteConfigSettings,
		nativeToolCallSetting,
		enableParallelToolCalling,
		backgroundEditEnabled,
		doubleCheckCompletionEnabled,
		lazyTeammateModeEnabled,
		showFeatureTips,
	} = useExtensionState()

	const handleFocusChainIntervalChange = useCallback(
		(value: number) => {
			updateSetting("focusChainSettings", { ...focusChainSettings, remindClineInterval: value })
		},
		[focusChainSettings],
	)

	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined
	const localizeFeature = useCallback(
		(feature: FeatureToggle) => {
			if (language !== "ko") {
				return feature
			}
			const labels: Record<string, string> = {
				subagents: "서브에이전트",
				"scheduled-agents": "예약 에이전트",
				"native-tool-call": "네이티브 도구 호출",
				"parallel-tool-calling": "병렬 도구 호출",
				"strict-plan-mode": "엄격한 Plan 모드",
				"auto-compact": "자동 압축(사용량 필요)",
				"focus-chain": "Focus Chain",
				"show-feature-tips": "기능 팁",
				"background-edit": "백그라운드 편집",
				checkpoints: "체크포인트",
				"cline-web-tools": "LIG VS 웹 도구",
				worktrees: "워크트리",
				yolo: "Yolo 모드",
				"double-check-completion": "완료 재확인",
				"lazy-teammate": "느슨한 팀메이트 모드",
				hooks: "훅",
			}
			const descriptions: Record<string, string> = {
				subagents: "코드베이스 탐색을 위해 집중 서브에이전트를 병렬로 실행합니다.",
				"scheduled-agents": "로컬 .cline/cron 사양으로 SDK 작업 영역 자동화를 켭니다.",
				"native-tool-call": "사용 가능한 경우 네이티브 함수 호출을 사용합니다.",
				"parallel-tool-calling": "여러 도구 호출을 동시에 실행합니다.",
				"strict-plan-mode": "Plan 모드에서 파일 편집을 막습니다.",
				"auto-compact": "신뢰 가능한 컨텍스트 사용량이 있을 때 압축을 요청합니다. 사용량을 보고하지 않는 공급자에서는 사용할 수 없습니다.",
				"focus-chain": "상호작용 사이의 컨텍스트 집중도를 유지합니다.",
				"show-feature-tips": "모델이 생각하는 동안 LIG VS 기능 팁을 표시합니다.",
				"background-edit": "에디터 포커스를 빼앗지 않고 편집합니다.",
				checkpoints: "되돌리기 쉽도록 주요 지점의 진행 상태를 저장합니다.",
				"cline-web-tools": "웹 탐색과 검색 기능을 사용할 수 있게 합니다.",
				worktrees: "병렬 LIG VS 작업을 위한 git worktree 관리를 켭니다.",
				yolo: "사용자 확인 없이 작업을 실행합니다. Plan에서 Act로 자동 전환하며 질문 도구를 비활성화합니다. 매우 주의해서 사용하세요.",
				"double-check-completion": "첫 완료 시도를 거부하고 원래 요구사항 기준으로 작업을 재검증하게 합니다.",
				"lazy-teammate": "가벼운 재미용 모드입니다.",
				hooks: "작업 실행 중 생명주기 및 도구 훅을 켭니다.",
			}
			return { ...feature, label: labels[feature.id] ?? feature.label, description: descriptions[feature.id] ?? feature.description }
		},
		[language],
	)

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		showFeatureTips,
		enableCheckpointsSetting,
		strictPlanModeEnabled,
		hooksEnabled,
		nativeToolCallSetting,
		focusChainEnabled: focusChainSettings?.enabled,
		useAutoCondense,
		subagentsEnabled,
		scheduledAgentsEnabled,
		clineWebToolsEnabled: clineWebToolsEnabled?.user,
		worktreesEnabled: worktreesEnabled?.user,
		enableParallelToolCalling,
		backgroundEditEnabled,
		doubleCheckCompletionEnabled,
		lazyTeammateModeEnabled,
		yoloModeToggled: isYoloRemoteLocked ? remoteConfigSettings?.yoloModeToggled : yoloModeToggled,
	}

	// Visibility lookup for features with feature flags
	const featureVisibility: Record<string, boolean | undefined> = {
		clineWebToolsEnabled: clineWebToolsEnabled?.featureFlag,
		worktreesEnabled: worktreesEnabled?.featureFlag,
	}

	// Handler for feature toggle changes, supports nested settings like focusChainSettings
	const handleFeatureChange = useCallback(
		(feature: FeatureToggle, checked: boolean) => {
			if (feature.nestedKey) {
				// For nested settings, spread the existing value and set the nested key
				let currentValue = {}
				if (feature.settingKey === "focusChainSettings") {
					currentValue = focusChainSettings ?? {}
				}
				updateSetting(feature.settingKey, { ...currentValue, [feature.nestedKey]: checked })
			} else {
				updateSetting(feature.settingKey, checked)
			}
		},
		[focusChainSettings],
	)

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
							{t("settings.features.group.agent")}
						</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="agent-features">
							{agentFeatures.map((rawFeature) => {
								const feature = localizeFeature(rawFeature)
								return (
									<div key={feature.id}>
										<FeatureRow
											checked={featureState[feature.stateKey]}
											description={feature.description}
											isVisible={featureVisibility[feature.stateKey] ?? true}
											label={feature.label}
											onChange={(checked) =>
												feature.nestedKey === "enabled"
													? handleFeatureChange(feature, checked)
													: updateSetting(feature.settingKey, checked)
											}
											switchId={rawFeature.label}
										/>
										{feature.id === "focus-chain" && featureState[feature.stateKey] && (
											<SettingsSlider
												label={t("settings.features.reminderInterval")}
												max={10}
												min={1}
												onChange={handleFocusChainIntervalChange}
												step={1}
												value={focusChainSettings?.remindClineInterval || 6}
												valueWidth="w-6"
											/>
										)}
									</div>
								)
							})}
						</div>
					</div>

					{/* Editor features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
							{t("settings.features.group.editor")}
						</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="optional-features">
							{editorFeatures.map((rawFeature) => {
								const feature = localizeFeature(rawFeature)
								return (
									<FeatureRow
										checked={featureState[feature.stateKey]}
										description={feature.description}
										isVisible={featureVisibility[feature.stateKey] ?? true}
										key={feature.id}
										label={feature.label}
										onChange={(checked) => handleFeatureChange(feature, checked)}
										switchId={rawFeature.label}
									/>
								)
							})}
						</div>
					</div>

					{/* Experimental features */}
					<div>
						<div className="text-xs font-medium uppercase tracking-wider mb-3 text-warning/80">
							{t("settings.features.group.experimental")}
						</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50 w-full"
							id="experimental-features">
							{experimentalFeatures.map((rawFeature) => {
								const feature = localizeFeature(rawFeature)
								return (
									<FeatureRow
										checked={featureState[feature.stateKey]}
										description={feature.description}
										disabled={feature.id === "yolo" && isYoloRemoteLocked}
										isRemoteLocked={feature.id === "yolo" && isYoloRemoteLocked}
										isVisible={featureVisibility[feature.stateKey] ?? true}
										key={feature.id}
										label={feature.label}
										onChange={(checked) => handleFeatureChange(feature, checked)}
										remoteTooltip={t("settings.remoteLocked")}
										switchId={rawFeature.label}
									/>
								)
							})}
						</div>
					</div>
				</div>

				{/* Advanced */}
				<div>
					<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">
						{t("settings.features.group.advanced")}
					</div>
					<div className="relative p-3 my-3 rounded-md border border-editor-widget-border/50" id="advanced-features">
						<div className="space-y-3">
							{advancedFeatures.map((rawFeature) => {
								const feature = localizeFeature(rawFeature)
								return (
									<FeatureRow
										checked={featureState[feature.stateKey]}
										description={feature.description}
										isVisible={featureVisibility[feature.stateKey] ?? true}
										key={feature.id}
										label={feature.label}
										onChange={(checked) => handleFeatureChange(feature, checked)}
										switchId={rawFeature.label}
									/>
								)
							})}

							{/* MCP Display Mode */}
							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">{t("settings.features.mcpDisplayMode")}</Label>
								<p className="text-xs text-muted-foreground">{t("settings.features.mcpDisplayModeHelp")}</p>
								<Select onValueChange={(v) => updateSetting("mcpDisplayMode", v)} value={mcpDisplayMode}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="plain">{t("settings.features.plainText")}</SelectItem>
										<SelectItem value="rich">{t("settings.features.richDisplay")}</SelectItem>
										<SelectItem value="markdown">{t("settings.features.markdown")}</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					</div>
				</div>
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)
