import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import PreferredLanguageSetting from "../PreferredLanguageSetting"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface GeneralSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const GeneralSettingsSection = ({ renderSectionHeader }: GeneralSettingsSectionProps) => {
	const { telemetrySetting, remoteConfigSettings, customPrompt } = useExtensionState()
	const { t } = useI18n()
	const [localCustomPrompt, setLocalCustomPrompt] = useState(customPrompt || "")
	const [isEditingCustomPrompt, setIsEditingCustomPrompt] = useState(false)
	const lastSentCustomPromptRef = useRef(customPrompt || "")

	useEffect(() => {
		const incoming = customPrompt || ""
		lastSentCustomPromptRef.current = incoming
		if (!isEditingCustomPrompt) {
			setLocalCustomPrompt(incoming)
		}
	}, [customPrompt, isEditingCustomPrompt])

	const saveCustomPrompt = useCallback((value: string) => {
		if (lastSentCustomPromptRef.current === value) {
			return
		}
		lastSentCustomPromptRef.current = value
		updateSetting("customPrompt" as any, value)
	}, [])

	useEffect(() => {
		const handle = window.setTimeout(() => {
			saveCustomPrompt(localCustomPrompt)
		}, 500)
		return () => window.clearTimeout(handle)
	}, [localCustomPrompt, saveCustomPrompt])

	return (
		<div>
			{renderSectionHeader("general")}
			<Section>
				<PreferredLanguageSetting />

				<div className="mb-5">
					<label className="block mb-1 font-semibold" htmlFor="custom-prompt">
						{t("settings.general.customPrompt")}
					</label>
					<textarea
						className="w-full min-h-[120px] box-border resize-y bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-solid border-(--vscode-input-border) rounded-[2px] p-2 font-inherit"
						id="custom-prompt"
						onChange={(event) => setLocalCustomPrompt(event.target.value)}
						onBlur={() => {
							setIsEditingCustomPrompt(false)
							saveCustomPrompt(localCustomPrompt)
						}}
						onFocus={() => setIsEditingCustomPrompt(true)}
						placeholder={t("settings.general.customPromptPlaceholder")}
						value={localCustomPrompt}
					/>
					<p className="text-sm mt-[5px] text-description">{t("settings.general.customPromptHelp")}</p>
				</div>

				<div className="mb-[5px]">
					<Tooltip>
						<TooltipContent hidden={remoteConfigSettings?.telemetrySetting === undefined}>
							{t("settings.remoteLocked")}
						</TooltipContent>
						<TooltipTrigger asChild>
							<div className="flex items-center gap-2 mb-[5px]">
								<VSCodeCheckbox
									checked={telemetrySetting !== "disabled"}
									disabled={remoteConfigSettings?.telemetrySetting === "disabled"}
									onChange={(e: any) => {
										const checked = e.target.checked === true
										updateSetting("telemetrySetting", checked ? "enabled" : "disabled")
									}}>
									{t("settings.general.telemetry")}
								</VSCodeCheckbox>
								{!!remoteConfigSettings?.telemetrySetting && (
									<i className="codicon codicon-lock text-description text-sm" />
								)}
							</div>
						</TooltipTrigger>
					</Tooltip>

					<p className="text-sm mt-[5px] text-description">
						{t("settings.general.telemetryHelp")}{" "}
						<VSCodeLink
							className="text-inherit"
							href="https://docs.cline.bot/more-info/telemetry"
							style={{ fontSize: "inherit", textDecoration: "underline" }}>
							{t("settings.general.telemetryOverview")}
						</VSCodeLink>{" "}
						{" / "}
						<VSCodeLink
							className="text-inherit"
							href="https://cline.bot/privacy"
							style={{ fontSize: "inherit", textDecoration: "underline" }}>
							{t("settings.general.privacyPolicy")}
						</VSCodeLink>{" "}
						{t("settings.general.moreDetails")}
					</p>
				</div>
			</Section>
		</div>
	)
}

export default GeneralSettingsSection
