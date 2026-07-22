import { afterEach, describe, expect, it, vi } from "vitest";
import { superviseStreamSubscription, type StreamSubscriptionCallbacks } from "./streamSubscriptionSupervisor";

describe("stream subscription supervisor", () => {
	afterEach(() => vi.useRealTimers());

	it("resubscribes after an error and ignores the previous generation", () => {
		vi.useFakeTimers();
		const observers: Array<StreamSubscriptionCallbacks<number>> = [];
		const cancelled: boolean[] = [];
		const received: number[] = [];
		const dispose = superviseStreamSubscription({
			label: "state",
			initialRetryDelayMs: 10,
			subscribe: (callbacks) => {
				const index = observers.push(callbacks) - 1;
				cancelled[index] = false;
				return () => {
					cancelled[index] = true;
				};
			},
			onResponse: (value) => received.push(value),
		});

		observers[0].onResponse(1);
		observers[0].onError(new Error("pipe closed"));
		vi.advanceTimersByTime(10);
		observers[0].onResponse(2);
		observers[1].onResponse(3);

		expect(cancelled[0]).toBe(true);
		expect(received).toEqual([1, 3]);
		dispose();
		expect(cancelled[1]).toBe(true);
	});

	it("backs off repeated completion and stops retrying after disposal", () => {
		vi.useFakeTimers();
		const observers: Array<StreamSubscriptionCallbacks<number>> = [];
		const dispose = superviseStreamSubscription({
			label: "partial",
			initialRetryDelayMs: 10,
			maximumRetryDelayMs: 40,
			subscribe: (callbacks) => {
				observers.push(callbacks);
				return () => undefined;
			},
			onResponse: () => undefined,
		});

		observers[0].onComplete();
		vi.advanceTimersByTime(9);
		expect(observers).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(observers).toHaveLength(2);
		observers[1].onComplete();
		dispose();
		vi.runAllTimers();
		expect(observers).toHaveLength(2);
	});
});
