import { type MouseEvent, useCallback, useRef, useState } from "react"

export interface QuoteButtonState {
	visible: boolean
	top: number
	left: number
	selectedText: string
}

const hiddenQuoteButton: QuoteButtonState = { visible: false, top: 0, left: 0, selectedText: "" }

export function useQuoteSelection(onSetQuote: (text: string) => void) {
	const [quoteButtonState, setQuoteButtonState] = useState<QuoteButtonState>(hiddenQuoteButton)
	const contentRef = useRef<HTMLDivElement>(null)

	const handleQuoteClick = useCallback(() => {
		onSetQuote(quoteButtonState.selectedText)
		window.getSelection()?.removeAllRanges()
		setQuoteButtonState(hiddenQuoteButton)
	}, [onSetQuote, quoteButtonState.selectedText])

	const handleMouseUp = useCallback((event: MouseEvent<HTMLDivElement>) => {
		const targetElement = event.target as Element
		const isClickOnButton = !!targetElement.closest(".quote-button-class")

		setTimeout(() => {
			const selection = window.getSelection()
			const selectedText = selection?.toString().trim() ?? ""
			if (selectedText && contentRef.current && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
				const rangeRect = selection.getRangeAt(0).getBoundingClientRect()
				const containerRect = contentRef.current.getBoundingClientRect()
				const tolerance = 5
				const isSelectionWithin =
					rangeRect.top >= containerRect.top &&
					rangeRect.left >= containerRect.left &&
					rangeRect.bottom <= containerRect.bottom + tolerance &&
					rangeRect.right <= containerRect.right

				if (isSelectionWithin) {
					setQuoteButtonState({
						visible: true,
						top: rangeRect.top - containerRect.top - 35,
						left: Math.max(0, rangeRect.left - containerRect.left),
						selectedText,
					})
					return
				}
			}

			if (!isClickOnButton) {
				setQuoteButtonState(hiddenQuoteButton)
			}
		}, 0)
	}, [])

	return { quoteButtonState, contentRef, handleQuoteClick, handleMouseUp }
}
