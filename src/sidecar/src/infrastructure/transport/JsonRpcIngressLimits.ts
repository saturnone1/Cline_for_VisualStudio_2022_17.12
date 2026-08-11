export type JsonLineFrameResult = Readonly<{ lines: string[]; overflow: boolean }>

export class JsonLineFrameDecoder {
	private buffer = ""
	private bufferedBytes = 0

	constructor(private readonly maximumFrameBytes: number) {
		if (!Number.isInteger(maximumFrameBytes) || maximumFrameBytes < 1) throw new Error("maximumFrameBytes must be a positive integer.")
	}

	push(chunk: string): JsonLineFrameResult {
		this.buffer += chunk
		this.bufferedBytes += Buffer.byteLength(chunk, "utf8")
		const lines: string[] = []

		for (;;) {
			const newlineIndex = this.buffer.indexOf("\n")
			if (newlineIndex < 0) break
			const rawLine = this.buffer.slice(0, newlineIndex)
			const consumed = this.buffer.slice(0, newlineIndex + 1)
			this.buffer = this.buffer.slice(newlineIndex + 1)
			this.bufferedBytes -= Buffer.byteLength(consumed, "utf8")
			if (Buffer.byteLength(rawLine, "utf8") > this.maximumFrameBytes) return this.fail(lines)
			const line = rawLine.trim()
			if (line) lines.push(line)
		}

		return this.bufferedBytes > this.maximumFrameBytes ? this.fail(lines) : { lines, overflow: false }
	}

	private fail(lines: string[]): JsonLineFrameResult {
		this.buffer = ""
		this.bufferedBytes = 0
		return { lines, overflow: true }
	}
}

export class BoundedAsyncRequestQueue {
	private readonly pending: Array<() => Promise<void>> = []
	private active = 0
	private disposed = false

	constructor(private readonly maximumConcurrent: number, private readonly maximumQueued: number) {
		if (!Number.isInteger(maximumConcurrent) || maximumConcurrent < 1) throw new Error("maximumConcurrent must be a positive integer.")
		if (!Number.isInteger(maximumQueued) || maximumQueued < 0) throw new Error("maximumQueued must be a non-negative integer.")
	}

	schedule(work: () => Promise<void>) {
		if (this.disposed) return false
		if (this.active < this.maximumConcurrent) this.start(work)
		else if (this.pending.length < this.maximumQueued) this.pending.push(work)
		else return false
		return true
	}

	dispose() {
		this.disposed = true
		this.pending.length = 0
	}

	private start(work: () => Promise<void>) {
		this.active++
		void work().catch(() => undefined).finally(() => {
			this.active--
			const next = this.disposed ? undefined : this.pending.shift()
			if (next) this.start(next)
		})
	}
}
