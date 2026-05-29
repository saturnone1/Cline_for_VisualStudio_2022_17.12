import * as React from "react"

type SlotProps = React.HTMLAttributes<HTMLElement> & {
	children?: React.ReactNode
}

export const Slot = React.forwardRef<HTMLElement, SlotProps>(({ children, ...props }, forwardedRef) => {
	if (!React.isValidElement(children)) {
		return null
	}

	const child = children as React.ReactElement<Record<string, unknown> & { ref?: React.Ref<unknown> }>
	const mergedProps = {
		...props,
		...child.props,
		className: [props.className, child.props.className].filter(Boolean).join(" "),
	}

	return React.cloneElement(child, {
		...mergedProps,
		ref: forwardedRef,
	})
})

Slot.displayName = "Slot"
