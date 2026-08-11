import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import LigBrandLockup from "./LigBrandLockup"

const LoadingScreen = () => {
	const { environment } = useExtensionState()
	const { language } = useI18n()
	const isKo = language === "ko"

	return (
		<div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-[var(--vscode-editor-background)] px-6 text-center text-[var(--vscode-foreground)]">
			<LigBrandLockup environment={environment} />
			<div className="mt-2 flex flex-col items-center gap-2 text-sm text-[var(--vscode-descriptionForeground)]">
				<div>{isKo ? "LIG VS를 준비하는 중입니다" : "Preparing LIG VS"}</div>
				<div className="h-1 w-44 overflow-hidden rounded-full bg-[var(--vscode-editorWidget-background)]">
					<div className="h-full w-1/2 animate-pulse rounded-full bg-[var(--vscode-button-background)]" />
				</div>
			</div>
		</div>
	)
}

export default LoadingScreen
