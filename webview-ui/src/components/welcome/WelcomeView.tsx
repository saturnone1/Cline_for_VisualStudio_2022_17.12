import { BooleanRequest, EmptyRequest } from "@shared/proto/cline/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { memo, useEffect, useState } from "react"
import ClineLogoWhite from "@/assets/ClineLogoWhite"
import ApiOptions from "@/components/settings/ApiOptions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { AccountServiceClient, StateServiceClient } from "@/services/grpc-client"
import { validateApiConfiguration } from "@/utils/validate"

const WelcomeView = memo(() => {
	const { apiConfiguration, mode } = useExtensionState()
	const { language } = useI18n()
	const [apiErrorMessage, setApiErrorMessage] = useState<string | undefined>(undefined)
	const [showApiOptions, setShowApiOptions] = useState(false)
	const [isLoading, setIsLoading] = useState(false)

	const disableLetsGoButton = apiErrorMessage != null

	const handleLogin = () => {
		setIsLoading(true)
		AccountServiceClient.accountLoginClicked(EmptyRequest.create())
			.catch((err) => console.error("Failed to get login URL:", err))
			.finally(() => {
				setIsLoading(false)
			})
	}

	const handleSubmit = async () => {
		try {
			await StateServiceClient.setWelcomeViewCompleted(BooleanRequest.create({ value: true }))
		} catch (error) {
			console.error("Failed to update API configuration or complete welcome view:", error)
		}
	}

	useEffect(() => {
		setApiErrorMessage(validateApiConfiguration(mode, apiConfiguration))
	}, [apiConfiguration, mode])

	return (
		<div className="fixed inset-0 p-0 flex flex-col">
			<div className="h-full px-5 overflow-auto flex flex-col gap-2.5">
				<div className="flex flex-col items-center gap-3 my-5">
					<ClineLogoWhite className="h-12 w-52 object-contain" />
				</div>
				<h2 className="text-lg font-semibold">{language === "ko" ? "안녕하세요, LIG VS입니다" : "Hi, I'm LIG VS"}</h2>
				<p>
					{language === "ko" ? (
						<>
							파일 생성/수정, 복잡한 프로젝트 탐색, 브라우저 사용, 승인 기반 터미널 명령 실행 도구로 개발 작업을
							도와드립니다. MCP를 통해 새 도구를 만들고 기능을 확장할 수도 있습니다.
						</>
					) : (
						<>
							I can create and edit files, explore complex projects, use a browser, and execute terminal commands{" "}
							<i>(with your permission, of course)</i>. I can even use MCP to create new tools and extend my own
							capabilities.
						</>
					)}
				</p>

				<p className="text-(--vscode-descriptionForeground)">
					{language === "ko"
						? "계정 기반 공급자를 사용하려면 로그인하거나, 로컬/엔터프라이즈 모델용 API 키를 직접 설정하세요."
						: "Sign in to use account-based providers, or configure your own API key for local and enterprise models."}
				</p>

				<VSCodeButton appearance="primary" className="w-full mt-1" disabled={isLoading} onClick={handleLogin}>
					{language === "ko" ? "무료로 시작하기" : "Get Started for Free"}
					{isLoading && (
						<span className="ml-1 animate-spin">
							<span className="codicon codicon-refresh" />
						</span>
					)}
				</VSCodeButton>

				{!showApiOptions && (
					<VSCodeButton
						appearance="secondary"
						className="mt-2.5 w-full"
						onClick={() => setShowApiOptions(!showApiOptions)}>
						{language === "ko" ? "직접 API 키 사용" : "Use your own API key"}
					</VSCodeButton>
				)}

				<div className="mt-4.5">
					{showApiOptions && (
						<div>
							<ApiOptions currentMode={mode} showModelOptions={false} />
							<VSCodeButton className="mt-0.75" disabled={disableLetsGoButton} onClick={handleSubmit}>
								{language === "ko" ? "시작하기" : "Let's go!"}
							</VSCodeButton>
						</div>
					)}
				</div>
			</div>
		</div>
	)
})

export default WelcomeView
