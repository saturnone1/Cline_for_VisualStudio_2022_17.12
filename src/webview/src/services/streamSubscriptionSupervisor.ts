export interface StreamSubscriptionCallbacks<T> {
	onResponse: (response: T) => void;
	onError: (error: Error) => void;
	onComplete: () => void;
}

export type StreamSubscriptionFactory<T> = (callbacks: StreamSubscriptionCallbacks<T>) => () => void;

export interface StreamSubscriptionSupervisorOptions<T> {
	label: string;
	subscribe: StreamSubscriptionFactory<T>;
	onResponse: (response: T) => void;
	initialRetryDelayMs?: number;
	maximumRetryDelayMs?: number;
	reportError?: (label: string, error: Error) => void;
}

/** Keeps a long-lived host stream subscribed across sidecar and named-pipe restarts. */
export function superviseStreamSubscription<T>(options: StreamSubscriptionSupervisorOptions<T>): () => void {
	const initialRetryDelayMs = options.initialRetryDelayMs ?? 250;
	const maximumRetryDelayMs = options.maximumRetryDelayMs ?? 5_000;
	let disposed = false;
	let generation = 0;
	let retryAttempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: (() => void) | undefined;

	const stopCurrent = () => {
		const current = unsubscribe;
		unsubscribe = undefined;
		try {
			current?.();
		} catch (error) {
			options.reportError?.(options.label, toError(error));
		}
	};

	const scheduleRetry = (streamGeneration: number, error?: Error) => {
		if (disposed || streamGeneration !== generation || retryTimer) {
			return;
		}
		if (error) {
			options.reportError?.(options.label, error);
		}
		generation++;
		stopCurrent();
		const delay = Math.min(initialRetryDelayMs * 2 ** retryAttempt, maximumRetryDelayMs);
		retryAttempt++;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			start();
		}, delay);
	};

	const start = () => {
		if (disposed) {
			return;
		}
		const streamGeneration = ++generation;
		let candidate: (() => void) | undefined;
		try {
			candidate = options.subscribe({
				onResponse: (response) => {
					if (disposed || streamGeneration !== generation) {
						return;
					}
					retryAttempt = 0;
					options.onResponse(response);
				},
				onError: (error) => scheduleRetry(streamGeneration, error),
				onComplete: () => scheduleRetry(streamGeneration),
			});
		} catch (error) {
			scheduleRetry(streamGeneration, toError(error));
			return;
		}

		if (disposed || streamGeneration !== generation) {
			candidate();
			return;
		}
		unsubscribe = candidate;
	};

	start();
	return () => {
		if (disposed) {
			return;
		}
		disposed = true;
		generation++;
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = undefined;
		}
		stopCurrent();
	};
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
