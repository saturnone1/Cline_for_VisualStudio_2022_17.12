const OBJECT_COERCION_PLACEHOLDER = /^\[object [A-Za-z][A-Za-z0-9]*\]$/

export function isNonDisplayableObjectCoercion(value: string) {
	return OBJECT_COERCION_PLACEHOLDER.test(value.trim())
}
