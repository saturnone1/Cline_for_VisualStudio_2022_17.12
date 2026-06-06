import type { VsClineSdkCapability, VsClineSdkCoverage, VsClineSdkLimitation } from "@shared/ExtensionMessage"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import ClineLogoVariable from "@/assets/ClineLogoVariable"
import { useI18n } from "@/i18n"
import Section from "../Section"

interface AboutSectionProps {
	version: string
	sdkCoverage?: VsClineSdkCoverage
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const CapabilityList = ({ items, title }: { items?: VsClineSdkCapability[]; title: string }) => {
	if (!items?.length) {
		return null
	}

	return (
		<div>
			<div className="font-medium">{title}</div>
			<ul className="m-0 mt-1 pl-4 text-xs text-description">
				{items.map((item) => (
					<li key={item.id}>
						{item.label} <span className="opacity-80">({item.owner})</span>
					</li>
				))}
			</ul>
		</div>
	)
}

const LimitationList = ({ items, title }: { items?: VsClineSdkLimitation[]; title: string }) => {
	if (!items?.length) {
		return null
	}

	return (
		<div>
			<div className="font-medium">{title}</div>
			<ul className="m-0 mt-1 pl-4 text-xs text-description">
				{items.map((item) => (
					<li key={item.id}>
						{item.label}: {item.reason}
					</li>
				))}
			</ul>
		</div>
	)
}

const AboutSection = ({ version, sdkCoverage, renderSectionHeader }: AboutSectionProps) => {
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

					<h3 className="text-md font-semibold">{language === "ko" ? "커뮤니티 및 지원" : "Community & Support"}</h3>
					<p>
						<VSCodeLink href="https://x.com/cline">X</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://discord.gg/cline">Discord</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://www.reddit.com/r/cline/"> r/cline</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">{language === "ko" ? "개발" : "Development"}</h3>
					<p>
						<VSCodeLink href="https://github.com/cline/cline">GitHub</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/cline/cline/issues"> Issues</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/cline/cline/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop">
							{" "}
							Feature Requests
						</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">{language === "ko" ? "리소스" : "Resources"}</h3>
					<p>
						<VSCodeLink href="https://docs.cline.bot/">Documentation</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://cline.bot/">https://cline.bot</VSCodeLink>
					</p>

					{sdkCoverage && (
						<div className="mt-2 flex flex-col gap-2 border-t border-[var(--vscode-widget-border)] pt-3">
							<h3 className="text-md font-semibold">{language === "ko" ? "SDK 진단" : "SDK Diagnostics"}</h3>
							<p className="m-0 text-xs text-description">
								{sdkCoverage.sdkPackage || "@cline/sdk"} {sdkCoverage.sdkVersion || "unknown"} ·{" "}
								{sdkCoverage.status || "unknown"}
							</p>
							{sdkCoverage.lastError && (
								<p className="m-0 text-xs text-[var(--vscode-errorForeground)]">{sdkCoverage.lastError}</p>
							)}
							<CapabilityList
								items={sdkCoverage.supported}
								title={language === "ko" ? "SDK 기반 지원 기능" : "Supported SDK-backed capabilities"}
							/>
							<CapabilityList
								items={sdkCoverage.partial}
								title={language === "ko" ? "축소 또는 부분 지원" : "Reduced or partial support"}
							/>
							<LimitationList
								items={sdkCoverage.visualStudioUnsupported}
								title={language === "ko" ? "Visual Studio 제한" : "Visual Studio limits"}
							/>
						</div>
					)}
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
