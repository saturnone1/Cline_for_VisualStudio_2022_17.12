export type CancellationParticipant = Readonly<{
	name: string
	cancel: () => Promise<unknown>
}>

export type CancellationFailure = Readonly<{ name: string; reason: string; timedOut: boolean }>
export type TaskCancellationResult = Readonly<{
	succeeded: boolean
	completed: string[]
	failures: CancellationFailure[]
}>

export class TaskCancellationCoordinator {
	constructor(
		private readonly timeoutMs: () => number,
		private readonly log: (event: string, details: Record<string, unknown>) => void,
	) {}

	async cancel(participants: readonly CancellationParticipant[]): Promise<TaskCancellationResult> {
		const unique = deduplicate(participants)
		const results = await Promise.all(unique.map((participant) => this.cancelOne(participant)))
		const completed = results.filter((result) => result.failure === undefined).map((result) => result.name)
		const failures = results.flatMap((result) => result.failure ? [result.failure] : [])
		this.log("taskCancellationCompleted", { completed, failures })
		return { succeeded: failures.length === 0, completed, failures }
	}

	private async cancelOne(participant: CancellationParticipant) {
		const timeoutMs = Math.max(250, this.timeoutMs())
		let timer: NodeJS.Timeout | undefined
		const operation = Promise.resolve().then(() => participant.cancel())
		try {
			await Promise.race([
				operation,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new CancellationTimeoutError(participant.name, timeoutMs)), timeoutMs)
				}),
			])
			return { name: participant.name }
		} catch (error) {
			const timedOut = error instanceof CancellationTimeoutError
			if (timedOut) {
				void operation.then(
					() => this.log("taskCancellationSettledAfterTimeout", { participant: participant.name, outcome: "completed" }),
					(lateError) => this.log("taskCancellationSettledAfterTimeout", { participant: participant.name, outcome: "failed", reason: stringify(lateError) }),
				)
			}
			return { name: participant.name, failure: { name: participant.name, reason: stringify(error), timedOut } }
		} finally {
			if (timer) clearTimeout(timer)
		}
	}
}

class CancellationTimeoutError extends Error {
	constructor(name: string, timeoutMs: number) {
		super(`${name} cancellation timed out after ${timeoutMs}ms.`)
	}
}

function deduplicate(participants: readonly CancellationParticipant[]) {
	const seen = new Set<string>()
	return participants.filter((participant) => participant.name && !seen.has(participant.name) && Boolean(seen.add(participant.name)))
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
