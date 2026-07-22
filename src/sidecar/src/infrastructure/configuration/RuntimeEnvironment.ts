export const RUNTIME_DEFAULTS = Object.freeze({
	apiRequestTimeoutMs: 600_000,
	webFetchTimeoutMs: 15_000,
	imageProbeTimeoutMs: 5_000,
	openGraphTimeoutMs: 15_000,
	taskOperationHistoryEntries: 2_048,
	taskCancelTimeoutMs: 4_000,
	shutdownGraceMs: 5_000,
})

export function readPositiveIntEnv(name: string, fallback: number) {
	const value = Number.parseInt(process.env[name] || "", 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

export function readBoundedPositiveIntEnv(name: string, fallback: number, minimum: number, maximum: number) {
	return Math.min(maximum, Math.max(minimum, readPositiveIntEnv(name, fallback)))
}
