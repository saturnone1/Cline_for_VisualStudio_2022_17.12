export interface InteractionLoggerPort {
	log(direction: string, event: string, payload?: unknown): void
}
