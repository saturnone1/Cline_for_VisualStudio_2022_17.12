import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useDebouncedInput } from "../utils/useDebouncedInput"

/**
 * Props for the DebouncedTextField component
 */
interface DebouncedTextFieldProps {
	// Custom props for debouncing functionality
	initialValue: string
	onChange: (value: string) => void

	// Common VSCodeTextField props
	style?: React.CSSProperties
	type?: "text" | "password"
	placeholder?: string
	id?: string
	children?: React.ReactNode
	disabled?: boolean
	className?: string
	inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]
	min?: string | number
	max?: string | number
	step?: string | number
}

/**
 * A wrapper around VSCodeTextField that automatically handles debounced input
 * to prevent excessive API calls while typing
 */
export const DebouncedTextField = ({
	initialValue,
	onChange,
	children,
	type,
	className,
	...otherProps
}: DebouncedTextFieldProps) => {
	const [localValue, setLocalValue, flushPendingChange] = useDebouncedInput(initialValue, onChange)

	return (
		<VSCodeTextField
			{...otherProps}
			className={className}
			onChange={(e: any) => {
				const value = e.target.value
				setLocalValue(value)
			}}
			onInput={(e: any) => {
				const value = e.target.value
				setLocalValue(value)
			}}
			onBlur={flushPendingChange}
			type={type}
			value={localValue}>
			{children}
		</VSCodeTextField>
	)
}
