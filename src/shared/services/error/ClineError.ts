export enum ClineErrorType {
	Balance = "balance",
	SpendLimit = "spend_limit",
	RateLimit = "rate_limit",
	QuotaExceeded = "quota_exceeded",
	Auth = "auth",
}

export class ClineError {
	message?: string
	providerId?: string
	_error?: Record<string, any>

	static parse(raw: string): ClineError | null {
		try {
			const parsed = JSON.parse(raw)
			const error = new ClineError()
			error.message = parsed?.message ?? raw
			error.providerId = parsed?.providerId ?? parsed?._error?.providerId
			error._error = parsed?._error ?? parsed
			return error
		} catch {
			const error = new ClineError()
			error.message = raw
			error._error = { message: raw }
			return error
		}
	}

	isErrorType(type: ClineErrorType): boolean {
		const currentType = this._error?.type ?? this._error?.errorType ?? this._error?.code
		return currentType === type
	}
}
