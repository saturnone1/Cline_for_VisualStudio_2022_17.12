import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { Mode } from "@shared/storage/types"
import type { ApiConfigurationProfile } from "@shared/ExtensionMessage"
import { VSCodeButton, VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { StateServiceClient } from "@/services/grpc-client"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
import ApiOptions from "../ApiOptions"
import Section from "../Section"
import { syncModeConfigurations } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

const ApiConfigurationSection = ({ renderSectionHeader, initialModelTab }: ApiConfigurationSectionProps) => {
	const {
		planActSeparateModelsSetting,
		mode,
		apiConfiguration,
		apiConfigurationProfiles,
		activeApiConfigurationProfileId,
	} = useExtensionState()
	const { t } = useI18n()
	const [currentTab, setCurrentTab] = useState<Mode>(mode)
	const [profileOperationPending, setProfileOperationPending] = useState(false)
	const [profileError, setProfileError] = useState("")
	const { handleFieldsChange } = useApiConfigurationHandlers()
	const profiles = apiConfigurationProfiles?.length
		? apiConfigurationProfiles
		: [
			{
				id: "default",
				name: "Default",
				apiConfiguration: apiConfiguration || {},
				planActSeparateModelsSetting,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		]
	const activeProfileId = activeApiConfigurationProfileId || profiles[0]?.id || "default"
	const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || profiles[0]
	const [profileName, setProfileName] = useState(activeProfile?.name || "Default")

	useEffect(() => {
		setProfileName(activeProfile?.name || "Default")
	}, [activeProfile?.id, activeProfile?.name])

	const persistProfiles = async (
		nextProfiles: ApiConfigurationProfile[],
		nextActiveProfileId = activeProfileId,
		extraSettings: Partial<UpdateSettingsRequest> = {},
	) => {
		setProfileOperationPending(true)
		setProfileError("")
		try {
			await StateServiceClient.updateSettings(
				UpdateSettingsRequest.create({
					...extraSettings,
					apiConfigurationProfiles: nextProfiles,
					activeApiConfigurationProfileId: nextActiveProfileId,
				} as any),
			)
		} catch (error) {
			console.error("Failed to update API profiles:", error)
			setProfileError(t("settings.apiProfiles.error"))
		} finally {
			setProfileOperationPending(false)
		}
	}

	const createProfileId = () => {
		const randomUUID = globalThis.crypto?.randomUUID?.()
		return randomUUID ? `profile-${randomUUID}` : `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
	}

	const createProfile = async (namePrefix: string, sourceProfile?: ApiConfigurationProfile) => {
		const now = new Date().toISOString()
		const id = createProfileId()
		const nextProfile: ApiConfigurationProfile = {
			id,
			name: `${namePrefix} ${profiles.length + 1}`,
			apiConfiguration: { ...(sourceProfile?.apiConfiguration || apiConfiguration || {}) },
			planActSeparateModelsSetting: sourceProfile?.planActSeparateModelsSetting ?? planActSeparateModelsSetting,
			createdAt: now,
			updatedAt: now,
		}
		await persistProfiles([...profiles, nextProfile], id, {
			apiConfiguration: nextProfile.apiConfiguration,
			planActSeparateModelsSetting: nextProfile.planActSeparateModelsSetting,
		} as any)
	}

	const renameProfile = async (name: string) => {
		const trimmed = name.trim()
		if (!activeProfile || !trimmed) {
			return
		}
		const now = new Date().toISOString()
		await persistProfiles(
			profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, name: trimmed, updatedAt: now } : profile),
		)
	}

	const deleteProfile = async () => {
		if (!activeProfile || profiles.length <= 1) {
			return
		}
		const remainingProfiles = profiles.filter((profile) => profile.id !== activeProfile.id)
		const nextActive = remainingProfiles[0]
		await persistProfiles(remainingProfiles, nextActive.id, {
			apiConfiguration: nextActive.apiConfiguration,
			planActSeparateModelsSetting: nextActive.planActSeparateModelsSetting,
		} as any)
	}

	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				<div className="mb-5 pb-4 border-0 border-b border-solid border-(--vscode-panel-border)">
					<div className="flex items-center justify-between gap-2 mb-2">
						<div className="font-semibold">{t("settings.apiProfiles.title")}</div>
						<div className="flex gap-1">
							<VSCodeButton appearance="secondary" disabled={profileOperationPending} onClick={() => createProfile(t("settings.apiProfiles.profilePrefix"))}>
								{t("settings.apiProfiles.new")}
							</VSCodeButton>
							<VSCodeButton appearance="secondary" disabled={!activeProfile || profileOperationPending} onClick={() => createProfile(t("settings.apiProfiles.copyPrefix"), activeProfile)}>
								{t("settings.apiProfiles.duplicate")}
							</VSCodeButton>
							<VSCodeButton appearance="secondary" disabled={profiles.length <= 1 || profileOperationPending} onClick={deleteProfile}>
								{t("settings.apiProfiles.delete")}
							</VSCodeButton>
						</div>
					</div>
					<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
						<label className="flex flex-col gap-1">
							<span className="text-xs text-description">{t("settings.apiProfiles.active")}</span>
							<select
								className="w-full h-7 bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-solid border-(--vscode-input-border) rounded-[2px] px-2"
								disabled={profileOperationPending}
								onChange={(event) => {
									const nextProfile = profiles.find((profile) => profile.id === event.target.value)
									if (!nextProfile) {
										return
									}
									void persistProfiles(profiles, nextProfile.id, {
										apiConfiguration: nextProfile.apiConfiguration,
										planActSeparateModelsSetting: nextProfile.planActSeparateModelsSetting,
									} as any)
								}}
								value={activeProfileId}>
								{profiles.map((profile) => (
									<option key={profile.id} value={profile.id}>
										{profile.name}
									</option>
								))}
							</select>
						</label>
						<VSCodeTextField
							className="w-full"
							disabled={profileOperationPending}
							onBlur={() => renameProfile(profileName)}
							onInput={(event: any) => setProfileName(event.target.value)}
							onKeyDown={(event: any) => {
								if (event.key === "Enter") {
									event.currentTarget.blur()
								}
							}}
							value={profileName}>
							<span className="text-xs text-description">{t("settings.apiProfiles.name")}</span>
						</VSCodeTextField>
					</div>
					{profileError && <p className="text-xs mt-2 mb-0 text-error">{profileError}</p>}
					<p className="text-xs mt-2 mb-0 text-description">
						{t("settings.apiProfiles.help")}
					</p>
				</div>

				{/* Tabs container */}
				{planActSeparateModelsSetting ? (
					<div className="rounded-md mb-5">
						<div className="flex gap-px mb-[10px] -mt-2 border-0 border-b border-solid border-(--vscode-panel-border)">
							<TabButton
								disabled={currentTab === "plan"}
								isActive={currentTab === "plan"}
								onClick={() => setCurrentTab("plan")}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								Plan Mode
							</TabButton>
							<TabButton
								disabled={currentTab === "act"}
								isActive={currentTab === "act"}
								onClick={() => setCurrentTab("act")}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								Act Mode
							</TabButton>
						</div>

						{/* Content container */}
						<div className="-mb-3">
							<ApiOptions currentMode={currentTab} initialModelTab={initialModelTab} showModelOptions={true} />
						</div>
					</div>
				) : (
					<ApiOptions currentMode={mode} initialModelTab={initialModelTab} showModelOptions={true} />
				)}

				<div className="mb-[5px]">
					<VSCodeCheckbox
						checked={planActSeparateModelsSetting}
						className="mb-[5px]"
						onChange={async (e: any) => {
							const checked = e.target.checked === true
							try {
								// If unchecking the toggle, wait a bit for state to update, then sync configurations
								if (!checked) {
									await syncModeConfigurations(apiConfiguration, currentTab, handleFieldsChange)
								}
								await StateServiceClient.updateSettings(
									UpdateSettingsRequest.create({
										planActSeparateModelsSetting: checked,
									} as any),
								)
							} catch (error) {
								console.error("Failed to update separate models setting:", error)
							}
						}}>
						Use different models for Plan and Act modes
					</VSCodeCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Switching between Plan and Act mode will persist the API and model used in the previous mode. This may be
						helpful e.g. when using a strong reasoning model to architect a plan for a cheaper coding model to act on.
					</p>
				</div>
			</Section>
		</div>
	)
}

export default ApiConfigurationSection
