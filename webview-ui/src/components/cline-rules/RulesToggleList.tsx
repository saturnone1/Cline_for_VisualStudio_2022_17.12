import NewRuleRow from "./NewRuleRow"
import RuleRow from "./RuleRow"
import { useI18n } from "@/i18n"

const RulesToggleList = ({
	rules,
	toggleRule,
	listGap = "medium",
	isGlobal,
	ruleType,
	showNewRule,
	showNoRules,
	isRemote = false,
	alwaysEnabledMap = {},
}: {
	rules: [string, boolean][]
	toggleRule: (rulePath: string, enabled: boolean) => void
	listGap?: "small" | "medium" | "large"
	isGlobal: boolean
	ruleType: string
	showNewRule: boolean
	showNoRules: boolean
	isRemote?: boolean
	alwaysEnabledMap?: Record<string, boolean>
}) => {
	const { t } = useI18n()
	const gapClasses = {
		small: "gap-0",
		medium: "gap-2.5",
		large: "gap-5",
	}

	const gapClass = gapClasses[listGap]

	return (
		<div className={`flex flex-col ${gapClass}`}>
			{rules.length > 0 ? (
				<>
					{rules.map(([rulePath, enabled]) => (
						<RuleRow
							alwaysEnabled={alwaysEnabledMap[rulePath]}
							enabled={enabled}
							isGlobal={isGlobal}
							isRemote={isRemote}
							key={rulePath}
							rulePath={rulePath}
							ruleType={ruleType}
							toggleRule={toggleRule}
						/>
					))}
					{showNewRule && <NewRuleRow isGlobal={isGlobal} ruleType={ruleType} />}
				</>
			) : (
				<>
					{showNoRules && (
						<div className="flex flex-col items-center gap-3 my-3 text-(--vscode-descriptionForeground)">
							{ruleType === "workflow" ? t("rules.noWorkflows") : t("rules.noRules")}
						</div>
					)}
					{showNewRule && <NewRuleRow isGlobal={isGlobal} ruleType={ruleType} />}
				</>
			)}
		</div>
	)
}

export default RulesToggleList
