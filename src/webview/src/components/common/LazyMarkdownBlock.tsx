import { lazy, Suspense } from "react"

const MarkdownBlock = lazy(() => import("./MarkdownBlock"))

type Props = Readonly<{
	markdown?: string
	compact?: boolean
	showCursor?: boolean
}>

export default function LazyMarkdownBlock(props: Props) {
	return (
		<Suspense fallback={<div className="whitespace-pre-wrap break-words">{props.markdown}</div>}>
			<MarkdownBlock {...props} />
		</Suspense>
	)
}
