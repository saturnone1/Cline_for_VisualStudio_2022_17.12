import type { VsClineSdkCoverage } from "@shared/ExtensionMessage"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import ClineLogoVariable from "@/assets/ClineLogoVariable"
import { useI18n } from "@/i18n"
import Section from "../Section"

interface AboutSectionProps {
	version: string
	sdkCoverage?: VsClineSdkCoverage
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const AboutSection = ({ version, renderSectionHeader }: AboutSectionProps) => {
	const { language } = useI18n()

	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<div className="flex flex-col items-start gap-2">
						<ClineLogoVariable className="h-10 w-48 object-contain" />
					</div>
					<h2 className="text-lg font-semibold">LIG VS v{version}</h2>
					<p>
						{language === "ko"
							? "CLI와 에디터를 사용할 수 있는 AI 개발 도우미입니다. 파일 생성/수정, 대규모 프로젝트 탐색, 브라우저 사용, 승인 기반 터미널 명령 실행을 통해 복잡한 개발 작업을 단계적으로 처리합니다."
							: "An AI assistant that can use your CLI and Editor. LIG VS can handle complex software development tasks step-by-step with tools that create and edit files, explore large projects, use the browser, and execute terminal commands after you grant permission."}
					</p>

					<div className="mt-2 flex flex-col gap-3 border-t border-[var(--vscode-widget-border)] pt-3">
						<div>
							<VSCodeLink href="https://github.com/cline/cline/tree/main/sdk/packages/sdk" className="font-semibold">
								Cline SDK
							</VSCodeLink>
							<p className="mb-0 mt-1 text-xs text-description">
								{language === "ko"
									? "Cline 에이전트 런타임을 다른 호스트에서 실행할 수 있도록 세션, 이벤트, 도구 실행 인터페이스를 제공하는 원본 SDK입니다."
									: "The upstream SDK that exposes sessions, events, and tool execution interfaces for running the Cline agent runtime in another host."}
							</p>
						</div>

						<div>
							<VSCodeLink href="https://github.com/cline/cline" className="font-semibold">
								Cline AI Agent
							</VSCodeLink>
							<p className="mb-0 mt-1 text-xs text-description">
								{language === "ko"
									? "코드 탐색과 편집, 명령 실행, 브라우저 및 MCP 도구를 사용하는 오픈소스 AI 코딩 에이전트 원본 프로젝트입니다."
									: "The upstream open-source AI coding agent for code exploration and editing, command execution, browser use, and MCP tools."}
							</p>
						</div>

						<div>
							<VSCodeLink
								href="https://github.com/saturnone1/Cline_for_VisualStudio_2022_17.12"
								className="font-semibold">
								LIG VS GitHub
							</VSCodeLink>
							<p className="mb-0 mt-1 text-xs text-description">
								{language === "ko"
									? "Cline SDK와 WebView를 Visual Studio 2022에 연결하고 17.0 및 17.12용 VSIX를 함께 제공하는 이 프로젝트의 저장소입니다."
									: "This project's repository, integrating the Cline SDK and WebView with Visual Studio 2022 and producing VSIX packages for 17.0 and 17.12."}
							</p>
						</div>
					</div>

					<h3 className="text-md font-semibold">{language === "ko" ? "현재 구현 내용" : "Currently Implemented"}</h3>
					<ul className="m-0 pl-5 text-xs text-description">
						<li>{language === "ko" ? "Cline SDK 세션과 대화 스트리밍, 취소, 복원 및 컨텍스트 압축" : "Cline SDK sessions, conversation streaming, cancellation, recovery, and context compaction"}</li>
						<li>{language === "ko" ? "Visual Studio 작업 영역의 파일 탐색·편집·검색과 명령 실행" : "Visual Studio workspace file exploration, editing, search, and command execution"}</li>
						<li>{language === "ko" ? "MCP 서버 연결과 도구 사용, 브라우저 및 웹 콘텐츠 도구" : "MCP server connections and tools, plus browser and web-content tools"}</li>
						<li>{language === "ko" ? "작업 기록, 체크포인트, 설정 저장 및 진단 로그" : "Task history, checkpoints, settings persistence, and diagnostic logs"}</li>
						<li>{language === "ko" ? "Visual Studio 2022 17.0·17.12 공통 WebView/sidecar 기반 VSIX" : "A shared WebView and sidecar VSIX for Visual Studio 2022 17.0 and 17.12"}</li>
					</ul>

					<h3 className="text-md font-semibold">
						{language === "ko" ? "앞으로 구현할 부분 및 미진한 부분" : "Planned and Partial Areas"}
					</h3>
					<ul className="m-0 pl-5 text-xs text-description">
						<li>{language === "ko" ? "Visual Studio 터미널 창과의 완전한 통합" : "First-class integration with the Visual Studio terminal pane"}</li>
						<li>{language === "ko" ? "파일 변경 검토·되돌리기와 체크포인트 diff 기능 고도화" : "Richer file review, undo, and checkpoint diff workflows"}</li>
						<li>{language === "ko" ? "MCP Marketplace, 원격 OAuth, resource·prompt 기능 보강" : "MCP Marketplace, remote OAuth, resources, and prompts"}</li>
						<li>{language === "ko" ? "Provider별 인증·모델 카탈로그 및 계정 기능의 완성도 향상" : "More complete provider authentication, model catalogs, and account flows"}</li>
						<li>{language === "ko" ? "Worktree 충돌 복구와 브라우저 재연결 등 예외 상황 안정화" : "More robust worktree conflict recovery and browser reconnection edge cases"}</li>
					</ul>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
