import type { VsClineSdkCoverage } from "@shared/ExtensionMessage"
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from "lucide-react"

type SdkCoverageStripProps = {
	coverage?: VsClineSdkCoverage
}

const chipClass =
	"inline-flex h-5 min-w-0 items-center gap-1 rounded-[3px] border border-editor-group-border px-1.5 text-[11px] leading-none"

export function SdkCoverageStrip({ coverage }: SdkCoverageStripProps) {
	if (!coverage) {
		return null
	}

	const supportedCount = coverage.supported.length
	const partialCount = coverage.partial.length
	const unsupportedCount = coverage.visualStudioUnsupported.length
	const title = [
		`${coverage.sdkPackage}${coverage.sdkVersion ? ` ${coverage.sdkVersion}` : ""}`,
		coverage.supported.map((item) => `${item.label}: ${item.owner}`).join("\n"),
		coverage.partial.length > 0 ? `Partial:\n${coverage.partial.map((item) => item.label).join("\n")}` : "",
		coverage.visualStudioUnsupported.length > 0
			? `Visual Studio limits:\n${coverage.visualStudioUnsupported.map((item) => `${item.label} - ${item.reason}`).join("\n")}`
			: "",
		coverage.lastError ? `Error:\n${coverage.lastError}` : "",
	]
		.filter(Boolean)
		.join("\n\n")

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-1.5 px-0.5 text-description" title={title}>
			<span className={chipClass}>
				<CheckCircle2Icon className="size-3 shrink-0 text-green-500" />
				<span className="truncate">SDK {supportedCount}</span>
			</span>
			{partialCount > 0 && (
				<span className={chipClass}>
					<InfoIcon className="size-3 shrink-0 text-blue-400" />
					<span className="truncate">Partial {partialCount}</span>
				</span>
			)}
			{unsupportedCount > 0 && (
				<span className={chipClass}>
					<AlertTriangleIcon className="size-3 shrink-0 text-yellow-500" />
					<span className="truncate">VS limits {unsupportedCount}</span>
				</span>
			)}
			<span className="min-w-0 truncate text-[11px]">{coverage.sdkPackage}</span>
		</div>
	)
}
