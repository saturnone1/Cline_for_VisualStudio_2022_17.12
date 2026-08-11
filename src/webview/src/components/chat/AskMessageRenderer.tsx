import {
	type ClineAskQuestion,
	type ClineMessage,
	type ClinePlanModeResponse,
	COMPLETION_RESULT_CHANGES_FLAG,
} from "@shared/ExtensionMessage"
import { FilePlus2Icon } from "lucide-react"
import type { MouseEvent, ReactNode, RefObject } from "react"
import { OptionsButtons } from "@/components/chat/OptionsButtons"
import { WithCopyButton } from "@/components/common/CopyButton"
import { useI18n } from "@/i18n"
import { CompletionOutputRow } from "./CompletionOutputRow"
import ErrorRow from "./ErrorRow"
import { MarkdownRow } from "./MarkdownRow"
import NewTaskPreview from "./NewTaskPreview"
import PlanCompletionOutputRow from "./PlanCompletionOutputRow"
import QuoteButton from "./QuoteButton"
import ReportBugPreview from "./ReportBugPreview"
import type { QuoteButtonState } from "./useQuoteSelection"

const HEADER_CLASSNAMES = "flex items-center gap-2.5 mb-3"
const InvisibleSpacer = () => <div aria-hidden className="h-px" />

export function parseAskQuestion(text: string | undefined): ClineAskQuestion {
	try {
		return JSON.parse(text || "{}") as ClineAskQuestion
	} catch {
		return { question: text }
	}
}

export function parsePlanResponse(text: string | undefined): ClinePlanModeResponse {
	try {
		return JSON.parse(text || "{}") as ClinePlanModeResponse
	} catch {
		return { response: text }
	}
}

interface AskMessageRendererProps {
	message: ClineMessage
	lastModifiedMessage?: ClineMessage
	isLast: boolean
	inputValue?: string
	title: ReactNode
	icon: ReactNode
	contentRef: RefObject<HTMLDivElement | null>
	handleMouseUp: (event: MouseEvent<HTMLDivElement>) => void
	quoteButtonState: QuoteButtonState
	handleQuoteClick: () => void
	seeNewChangesDisabled: boolean
	setSeeNewChangesDisabled: (value: boolean) => void
	explainChangesDisabled: boolean
	setExplainChangesDisabled: (value: boolean) => void
}

export function AskMessageRenderer({
	message,
	lastModifiedMessage,
	isLast,
	inputValue,
	title,
	icon,
	contentRef,
	handleMouseUp,
	quoteButtonState,
	handleQuoteClick,
	seeNewChangesDisabled,
	setSeeNewChangesDisabled,
	explainChangesDisabled,
	setExplainChangesDisabled,
}: AskMessageRendererProps) {
	const { t } = useI18n()
	switch (message.ask) {
		case "mistake_limit_reached":
			return <ErrorRow errorType="mistake_limit_reached" message={message} />
		case "completion_result": {
			if (!message.text) return <InvisibleSpacer />
			const hasChanges = message.text.endsWith(COMPLETION_RESULT_CHANGES_FLAG)
			const text = hasChanges ? message.text.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text
			if (!hasChanges) return <div className="text-sm text-description py-0.5">{text || t("task.done")}</div>
			return (
				<CompletionOutputRow
					explainChangesDisabled={explainChangesDisabled}
					handleQuoteClick={handleQuoteClick}
					messageTs={message.ts}
					quoteButtonState={quoteButtonState}
					seeNewChangesDisabled={seeNewChangesDisabled}
					setExplainChangesDisabled={setExplainChangesDisabled}
					setSeeNewChangesDisabled={setSeeNewChangesDisabled}
					showActionRow={message.partial !== true}
					text={text}
				/>
			)
		}
		case "followup": {
			const { question, options, selected } = parseAskQuestion(message.text)
			return (
				<div>
					{title && <div className={HEADER_CLASSNAMES}>{icon}{title}</div>}
					<WithCopyButton className="pt-1" onMouseUp={handleMouseUp} position="bottom-right" ref={contentRef} textToCopy={question}>
						<MarkdownRow markdown={question} />
						{quoteButtonState.visible && <QuoteButton left={quoteButtonState.left} onClick={handleQuoteClick} top={quoteButtonState.top} />}
					</WithCopyButton>
					<div className="pt-3">
						<OptionsButtons
							inputValue={inputValue}
							isActive={(isLast && lastModifiedMessage?.ask === "followup") || (!selected && !!options?.length)}
							options={options}
							selected={selected}
						/>
					</div>
				</div>
			)
		}
		case "new_task":
			return <TaskPreview title="LIG VS가 새 작업을 시작하려고 합니다:" text={message.text} />
		case "condense":
			return <TaskPreview title="LIG VS가 대화를 압축하려고 합니다:" text={message.text} />
		case "report_bug":
			return (
				<div>
					<div className={HEADER_CLASSNAMES}><FilePlus2Icon className="size-2" /><span className="text-foreground font-bold">LIG VS가 GitHub 이슈를 만들려고 합니다:</span></div>
					<ReportBugPreview data={message.text || ""} />
				</div>
			)
		case "plan_mode_respond": {
			const { response, options, selected } = parsePlanResponse(message.text)
			return (
				<div>
					<PlanCompletionOutputRow headClassNames={HEADER_CLASSNAMES} text={response || message.text || ""} />
					<OptionsButtons
						inputValue={inputValue}
						isActive={(isLast && lastModifiedMessage?.ask === "plan_mode_respond") || (!selected && !!options?.length)}
						options={options}
						selected={selected}
					/>
				</div>
			)
		}
		default:
			return <InvisibleSpacer />
	}
}

function TaskPreview({ title, text }: { title: string; text?: string }) {
	return (
		<div>
			<div className={HEADER_CLASSNAMES}><FilePlus2Icon className="size-2" /><span className="text-foreground font-bold">{title}</span></div>
			<NewTaskPreview context={text || ""} />
		</div>
	)
}
