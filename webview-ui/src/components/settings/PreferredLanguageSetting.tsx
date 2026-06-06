import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import React from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { updateSetting } from "./utils/settingsHandlers"

const PreferredLanguageSetting: React.FC = () => {
	const { preferredLanguage, uiLanguage } = useExtensionState()
	const { t } = useI18n()
	const selectedUiLanguage = uiLanguage === "en" ? "en" : "ko"
	const selectedLanguage = preferredLanguage === "Korean - 한국어" ? "Korean - 한국어" : "English"

	const handleLanguageChange = (newLanguage: string) => {
		updateSetting("preferredLanguage", newLanguage)
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<label className="block mb-1 text-base font-medium" htmlFor="ui-language-dropdown">
					{t("settings.interfaceLanguage.label")}
				</label>
				<VSCodeDropdown
					id="ui-language-dropdown"
					onChange={(e: any) => {
						updateSetting("uiLanguage" as any, e.currentTarget?.value || e.target.value)
					}}
					style={{ width: "100%" }}
					value={selectedUiLanguage}>
					<VSCodeOption selected={selectedUiLanguage === "ko"} value="ko">
						{t("settings.language.korean")}
					</VSCodeOption>
					<VSCodeOption selected={selectedUiLanguage === "en"} value="en">
						{t("settings.language.english")}
					</VSCodeOption>
				</VSCodeDropdown>
				<p className="text-sm text-description mt-1">{t("settings.interfaceLanguage.help")}</p>
			</div>
			<div>
				<label className="block mb-1 text-base font-medium" htmlFor="preferred-language-dropdown">
					{t("settings.responseLanguage.label")}
				</label>
				<VSCodeDropdown
					id="preferred-language-dropdown"
					onChange={(e: any) => {
						handleLanguageChange(e.currentTarget?.value || e.target.value)
					}}
					style={{ width: "100%" }}
					value={selectedLanguage}>
					<VSCodeOption selected={selectedLanguage === "Korean - 한국어"} value="Korean - 한국어">
						{t("settings.language.korean")}
					</VSCodeOption>
					<VSCodeOption selected={selectedLanguage === "English"} value="English">
						{t("settings.language.english")}
					</VSCodeOption>
				</VSCodeDropdown>
				<p className="text-sm text-description mt-1">{t("settings.responseLanguage.help")}</p>
			</div>
		</div>
	)
}

export default React.memo(PreferredLanguageSetting)
