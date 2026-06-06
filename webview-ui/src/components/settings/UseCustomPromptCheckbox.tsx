import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import React, { useCallback, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { updateSetting } from "./utils/settingsHandlers"

interface CustomPromptCheckboxProps {
	providerId: string
}

/**
 * Checkbox to enable or disable the use of a compact prompt for local models providers.
 */
const UseCustomPromptCheckbox: React.FC<CustomPromptCheckboxProps> = ({ providerId }) => {
	const { customPrompt } = useExtensionState()
	const { t } = useI18n()
	const [isCompactPromptEnabled, setIsCompactPromptEnabled] = useState<boolean>(customPrompt === "compact")

	const toggleCompactPrompt = useCallback((isChecked: boolean) => {
		setIsCompactPromptEnabled(isChecked)
		updateSetting("customPrompt", isChecked ? "compact" : "")
	}, [])

	return (
		<div id={providerId}>
			<VSCodeCheckbox checked={isCompactPromptEnabled} onChange={() => toggleCompactPrompt(!isCompactPromptEnabled)}>
				{t("settings.compactPrompt.label")}
			</VSCodeCheckbox>
			<div className="text-xs text-description">
				{t("settings.compactPrompt.help")}
				<div className="text-error flex align-middle">
					<i className="codicon codicon-x" />
					{t("settings.compactPrompt.unsupported")}
				</div>
			</div>
		</div>
	)
}

export default UseCustomPromptCheckbox
