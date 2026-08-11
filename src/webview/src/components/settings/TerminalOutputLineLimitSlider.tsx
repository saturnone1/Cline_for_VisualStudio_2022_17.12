import React, { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { updateSetting } from "./utils/settingsHandlers"

const TerminalOutputLineLimitSlider: React.FC = () => {
	const { terminalOutputLineLimit } = useExtensionState()
	const { t } = useI18n()
	const persistedValue = terminalOutputLineLimit ?? 500
	const [value, setValue] = useState(persistedValue)

	useEffect(() => setValue(persistedValue), [persistedValue])

	const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setValue(parseInt(event.target.value, 10))
	}

	const commitValue = () => {
		if (value !== persistedValue) updateSetting("terminalOutputLineLimit", value)
	}

	return (
		<div style={{ marginBottom: 15 }}>
			<label htmlFor="terminal-output-limit" style={{ fontWeight: "500", display: "block", marginBottom: 5 }}>
				{t("settings.terminal.outputLimit")}
			</label>
			<div style={{ display: "flex", alignItems: "center" }}>
				<input
					id="terminal-output-limit"
					max="5000"
					min="100"
					onChange={handleSliderChange}
					onBlur={commitValue}
					onKeyUp={commitValue}
					onPointerUp={commitValue}
					step="100"
					style={{ flexGrow: 1, marginRight: "1rem" }}
					type="range"
					value={value}
				/>
				<span>{value}</span>
			</div>
			<p style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", margin: "5px 0 0 0" }}>
				{t("settings.terminal.outputLimitHelp")}
			</p>
		</div>
	)
}

export default TerminalOutputLineLimitSlider
