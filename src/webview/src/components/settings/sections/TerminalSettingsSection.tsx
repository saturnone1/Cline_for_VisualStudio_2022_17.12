import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { StateServiceClient } from "../../../services/grpcClient"
import Section from "../Section"
import TerminalOutputLineLimitSlider from "../TerminalOutputLineLimitSlider"
import { updateSetting } from "../utils/settingsHandlers"

interface TerminalSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

export const TerminalSettingsSection: React.FC<TerminalSettingsSectionProps> = ({ renderSectionHeader }) => {
	const { t } = useI18n()
	const {
		shellIntegrationTimeout,
		terminalReuseEnabled,
		defaultTerminalProfile,
		availableTerminalProfiles,
	} = useExtensionState()

	const normalizedWaitMs = shellIntegrationTimeout >= 1_000 ? shellIntegrationTimeout : 30_000
	const [inputValue, setInputValue] = useState((normalizedWaitMs / 1000).toString())
	const [inputError, setInputError] = useState<string | null>(null)

	useEffect(() => {
		setInputValue((normalizedWaitMs / 1000).toString())
	}, [normalizedWaitMs])

	const validateTimeout = (value: string) => {
		const seconds = Number(value)
		return Number.isFinite(seconds) && seconds >= 1 ? Math.round(seconds * 1000) : null
	}

	const handleTimeoutChange = (event: Event) => {
		const target = event.target as HTMLInputElement
		const value = target.value
		setInputValue(value)
		setInputError(validateTimeout(value) === null ? t("settings.terminal.timeoutError") : null)
	}

	const commitTimeout = async () => {
		const timeoutMs = validateTimeout(inputValue)
		if (timeoutMs === null) {
			setInputValue((normalizedWaitMs / 1000).toString())
			setInputError(null)
			return
		}
		if (timeoutMs === normalizedWaitMs) return
		try {
			await StateServiceClient.updateTerminalConnectionTimeout({ timeoutMs })
		} catch {
			setInputValue((normalizedWaitMs / 1000).toString())
			setInputError(t("settings.terminal.timeoutUpdateError"))
		}
	}

	const handleTerminalReuseChange = (event: Event) => {
		const target = event.target as HTMLInputElement
		const checked = target.checked
		updateSetting("terminalReuseEnabled", checked)
	}

	// Use any to avoid type conflicts between Event and FormEvent
	const handleDefaultTerminalProfileChange = (event: any) => {
		const target = event.target as HTMLSelectElement
		const profileId = target.value

		// Save immediately using the consolidated updateSettings approach
		updateSetting("defaultTerminalProfile", profileId || "visual-studio-command-host")
	}

	const profilesToShow = availableTerminalProfiles.length > 0
		? availableTerminalProfiles
		: [{ id: "visual-studio-command-host", name: t("settings.terminal.profile.developerCommandPrompt") }]
	const selectedProfile = defaultTerminalProfile && defaultTerminalProfile !== "default"
		? defaultTerminalProfile
		: "visual-studio-command-host"

	return (
		<div>
			{renderSectionHeader("terminal")}
			<Section>
				<div className="mb-5" id="terminal-settings-section">
					<div className="mb-4">
						<label className="font-medium block mb-1" htmlFor="default-terminal-profile">
							{t("settings.terminal.defaultProfile")}
						</label>
						<VSCodeDropdown
							className="w-full"
							id="default-terminal-profile"
							onChange={handleDefaultTerminalProfileChange}
							value={selectedProfile}>
							{profilesToShow.map((profile) => (
								<VSCodeOption key={profile.id} title={profile.description} value={profile.id}>
									{terminalProfileLabel(profile.id, profile.name, t)}
								</VSCodeOption>
							))}
						</VSCodeDropdown>
						<p className="text-xs text-(--vscode-descriptionForeground) mt-1">
							{t("settings.terminal.defaultProfileHelp")}
						</p>
					</div>

					<div className="mb-4">
						<div className="mb-2">
							<label className="font-medium block mb-1">{t("settings.terminal.timeout")}</label>
							<div className="flex items-center">
								<VSCodeTextField
									className="w-full"
									onBlur={() => void commitTimeout()}
									onChange={(event) => handleTimeoutChange(event as Event)}
									onKeyDown={(event) => {
										if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur()
									}}
									placeholder={t("settings.terminal.timeoutPlaceholder")}
									value={inputValue}
								/>
							</div>
							{inputError && <div className="text-(--vscode-errorForeground) text-xs mt-1">{inputError}</div>}
						</div>
						<p className="text-xs text-(--vscode-descriptionForeground)">
							{t("settings.terminal.timeoutHelp")}
						</p>
					</div>

					<div className="mb-4">
						<div className="flex items-center mb-2">
							<VSCodeCheckbox
								checked={terminalReuseEnabled ?? true}
								onChange={(event) => handleTerminalReuseChange(event as Event)}>
								{t("settings.terminal.reuse")}
							</VSCodeCheckbox>
						</div>
						<p className="text-xs text-(--vscode-descriptionForeground)">
							{t("settings.terminal.reuseHelp")}
						</p>
					</div>
					<TerminalOutputLineLimitSlider />
				</div>
			</Section>
		</div>
	)
}

export default TerminalSettingsSection

function terminalProfileLabel(id: string, fallback: string, t: (key: any) => string) {
	switch (id) {
		case "visual-studio-command-host": return t("settings.terminal.profile.developerCommandPrompt")
		case "visual-studio-developer-powershell": return t("settings.terminal.profile.developerPowerShell")
		case "windows-command-prompt": return t("settings.terminal.profile.commandPrompt")
		case "windows-powershell": return t("settings.terminal.profile.windowsPowerShell")
		default: return fallback
	}
}
