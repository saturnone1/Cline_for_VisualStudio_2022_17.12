import { toRequestyServiceUrl } from "@shared/clients/requesty"
import { StringRequest } from "@shared/proto/cline/common"
import { Mode } from "@shared/storage/types"
import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { AccountServiceClient } from "@/services/grpcClient"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import RequestyModelPicker from "../RequestyModelPicker"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the RequestyProvider component
 */
interface RequestyProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Requesty provider configuration component
 */
export const RequestyProvider = ({ showModelOptions, isPopup, currentMode }: RequestyProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { t } = useI18n()
	const { handleFieldChange } = useApiConfigurationHandlers()

	const [requestyEndpointSelected, setRequestyEndpointSelected] = useState(!!apiConfiguration?.requestyBaseUrl)
	const [authMessage, setAuthMessage] = useState("")

	const resolvedUrl = toRequestyServiceUrl(apiConfiguration?.requestyBaseUrl, "app")
	const apiKeyUrl = resolvedUrl != null ? new URL("api-keys", resolvedUrl).toString() : undefined

	return (
		<div style={{ display: "flex", flexDirection: "column" }}>
			<ApiKeyField
				initialValue={apiConfiguration?.requestyApiKey || ""}
				onChange={(value) => handleFieldChange("requestyApiKey", value)}
				providerName="Requesty"
				signupUrl={apiKeyUrl}
			/>
			{!apiConfiguration?.requestyApiKey && (
				<VSCodeButton
					appearance="secondary"
					onClick={async () => {
						try {
							const response = await AccountServiceClient.requestyAuthClicked(
								StringRequest.create({
									value: apiConfiguration?.requestyBaseUrl || "",
								}),
							)
							setAuthMessage(response?.message || t("settings.api.apiKeyPageOpened", { provider: "Requesty" }))
						} catch (error) {
							console.error("Failed to open Requesty auth:", error)
							setAuthMessage(error instanceof Error ? error.message : String(error))
						}
					}}
					style={{ margin: "5px 0 0 0" }}>
					{t("settings.api.getProviderApiKey", { provider: "Requesty" })}
				</VSCodeButton>
			)}
			{authMessage && <p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, marginTop: 8 }}>{authMessage}</p>}
			<VSCodeCheckbox
				checked={requestyEndpointSelected}
				onChange={(e: any) => {
					const isChecked = e.target.checked === true
					setRequestyEndpointSelected(isChecked)

					if (!isChecked) {
						handleFieldChange("requestyBaseUrl", undefined)
					}
				}}>
				{t("settings.api.customBaseUrl")}
			</VSCodeCheckbox>
			{requestyEndpointSelected && (
				<DebouncedTextField
					initialValue={apiConfiguration?.requestyBaseUrl ?? ""}
					onChange={(value) => {
						if (value.length === 0) {
							handleFieldChange("requestyBaseUrl", undefined)
						} else {
							handleFieldChange("requestyBaseUrl", value)
						}
					}}
					placeholder={t("settings.api.customBaseUrlPlaceholder")}
					style={{ width: "100%", marginBottom: 5 }}
					type="text"
				/>
			)}
			{showModelOptions && (
				<RequestyModelPicker baseUrl={apiConfiguration?.requestyBaseUrl} currentMode={currentMode} isPopup={isPopup} />
			)}
		</div>
	)
}
