import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import ligMarkWhite from "@/assets/lig-mark-white.png"
import { useClineSignIn } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import ClineLogoVariable from "../../assets/ClineLogoVariable"

// export const AccountWelcomeView = () => (
// 	<div className="flex flex-col items-center pr-3 gap-2.5">
// 		<ClineLogoWhite className="size-16 mb-4" />
export const AccountWelcomeView = () => {
	const { environment } = useExtensionState()
	const { language } = useI18n()
	const { isLoginLoading, handleSignIn } = useClineSignIn()

	return (
		<div className="flex flex-col items-center gap-2.5">
			<img alt="" className="h-10 w-auto object-contain" src={ligMarkWhite} />
			<ClineLogoVariable className="h-12 w-48 object-contain mb-4" environment={environment} />

			<p>
				{language === "ko"
					? "계정으로 로그인하면 최신 모델, 사용량과 크레딧을 확인할 수 있는 대시보드, 이후 제공될 기능을 사용할 수 있습니다."
					: "Sign up for an account to get access to the latest models, billing dashboard to view usage and credits, and more upcoming features."}
			</p>

			<VSCodeButton className="w-full mb-4" disabled={isLoginLoading} onClick={handleSignIn}>
				{language === "ko" ? "LIG VS 계정으로 시작" : "Sign up with LIG VS"}
				{isLoginLoading && (
					<span className="ml-1 animate-spin">
						<span className="codicon codicon-refresh"></span>
					</span>
				)}
			</VSCodeButton>

			<p className="text-(--vscode-descriptionForeground) text-xs text-center m-0">
				{language === "ko" ? "계속하면 " : "By continuing, you agree to the "}
				<VSCodeLink href="https://cline.bot/tos">{language === "ko" ? "서비스 약관" : "Terms of Service"}</VSCodeLink>
				{language === "ko" ? " 및 " : " and "}
				<VSCodeLink href="https://cline.bot/privacy">{language === "ko" ? "개인정보 처리방침" : "Privacy Policy"}</VSCodeLink>
				{language === "ko" ? "에 동의합니다." : "."}
			</p>
		</div>
	)
}
