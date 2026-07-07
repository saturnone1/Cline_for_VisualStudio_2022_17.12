import { EmptyRequest } from "@shared/proto/cline/common"
import { ShieldCheck, Sparkles } from "lucide-react"
import ligMarkBlack from "@/assets/lig-mark-black.png"
import ligMarkWhite from "@/assets/lig-mark-white.png"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { UiServiceClient } from "@/services/grpc-client"

interface HomeHeaderProps {
	shouldShowQuickWins?: boolean
}

const HomeHeader = ({ shouldShowQuickWins = false }: HomeHeaderProps) => {
	const { environment, lazyTeammateModeEnabled } = useExtensionState()
	const { language } = useI18n()
	const ligMark = environment === "local" ? ligMarkBlack : ligMarkWhite

	const handleTakeATour = async () => {
		try {
			await UiServiceClient.openWalkthrough(EmptyRequest.create())
		} catch (error) {
			console.error("Error opening walkthrough:", error)
		}
	}

	const headingText =
		language === "ko"
			? lazyTeammateModeEnabled
				? "LIG VS가 준비되었습니다"
				: "무엇을 도와드릴까요?"
			: lazyTeammateModeEnabled
				? "LIG VS is ready"
				: "What can I do for you?"

	return (
		<div className="flex flex-col items-center mb-5">
			<div className="my-7 flex flex-col items-center gap-4 px-4">
				<div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-[var(--vscode-focusBorder)]/35 bg-[var(--vscode-editorWidget-background)] shadow-[0_14px_34px_rgba(0,0,0,0.22)]">
					<div className="absolute -right-1 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--vscode-focusBorder)]/45 bg-[var(--vscode-editor-background)]">
						<Sparkles className="h-3.5 w-3.5 text-[var(--vscode-focusBorder)]" />
					</div>
					<div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--vscode-button-background)]">
						<img alt="LIG" className="h-7 w-7 object-contain" src={ligMark} />
					</div>
					<ShieldCheck className="absolute -bottom-1 left-1 h-6 w-6 rounded-full bg-[var(--vscode-editor-background)] p-1 text-[var(--vscode-testing-iconPassed)]" />
				</div>
				<div className="flex flex-col items-center text-center">
					<div className="text-[clamp(2.25rem,16vw,4.75rem)] leading-none font-black tracking-normal text-[var(--vscode-foreground)]">
						LIG VS
					</div>
					<div className="mt-2 text-sm font-semibold tracking-normal text-[var(--vscode-descriptionForeground)]">
						by M&amp;S.Team3
					</div>
				</div>
			</div>
			<div className="text-center flex items-center justify-center px-4">
				<h1 className="m-0 font-bold">{headingText}</h1>
			</div>
			{shouldShowQuickWins && (
				<div className="mt-4">
					<button
						className="flex items-center gap-2 px-4 py-2 rounded-full border border-border-panel bg-white/2 hover:bg-list-background-hover transition-colors duration-150 ease-in-out text-code-foreground text-sm font-medium cursor-pointer"
						onClick={handleTakeATour}
						type="button">
						{language === "ko" ? "둘러보기" : "Take a Tour"}
						<span className="codicon codicon-play scale-90" />
					</button>
				</div>
			)}
		</div>
	)
}

export default HomeHeader
