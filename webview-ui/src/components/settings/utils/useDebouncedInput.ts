import { useCallback, useEffect, useRef, useState } from "react"

/**
 * A custom hook that provides debounced input handling to prevent jumpy text inputs
 * when saving changes directly to backend on every keystroke.
 *
 * @param initialValue - The initial value for the input
 * @param onChange - Callback function to save the value (e.g., to backend)
 * @param debounceMs - Debounce delay in milliseconds (default: 500ms)
 * @returns A tuple of [currentValue, setValue, flushPendingChange]
 */
export function useDebouncedInput<T>(
	initialValue: T,
	onChange: (value: T) => void,
	debounceMs: number = 100,
): [T, (value: T) => void, () => void] {
	// Local state to prevent jumpy input - initialize once
	const [localValue, setLocalValue] = useState(initialValue)

	// Track previous initialValue to detect external changes
	const prevInitialValueRef = useRef<T>(initialValue)
	const latestValueRef = useRef<T>(initialValue)
	const committedValueRef = useRef<T>(initialValue)
	const hasPendingChangeRef = useRef(false)
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const onChangeRef = useRef(onChange)

	useEffect(() => {
		onChangeRef.current = onChange
	}, [onChange])

	const clearPendingTimeout = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current)
			timeoutRef.current = null
		}
	}, [])

	const flushPendingChange = useCallback(() => {
		if (!hasPendingChangeRef.current) {
			return
		}

		clearPendingTimeout()
		hasPendingChangeRef.current = false
		committedValueRef.current = latestValueRef.current
		onChangeRef.current(latestValueRef.current)
	}, [clearPendingTimeout])

	// Sync local state when initialValue changes externally (e.g., when switching Plan/Act tabs)
	useEffect(() => {
		if (prevInitialValueRef.current !== initialValue) {
			clearPendingTimeout()
			setLocalValue(initialValue)
			latestValueRef.current = initialValue
			committedValueRef.current = initialValue
			hasPendingChangeRef.current = false
			prevInitialValueRef.current = initialValue
		}
	}, [clearPendingTimeout, initialValue])

	const setValue = useCallback(
		(value: T) => {
			setLocalValue(value)
			latestValueRef.current = value
			hasPendingChangeRef.current = value !== committedValueRef.current

			clearPendingTimeout()
			if (hasPendingChangeRef.current) {
				timeoutRef.current = setTimeout(flushPendingChange, debounceMs)
			}
		},
		[clearPendingTimeout, debounceMs, flushPendingChange],
	)

	useEffect(() => {
		return () => {
			flushPendingChange()
		}
	}, [flushPendingChange])

	return [localValue, setValue, flushPendingChange]
}
