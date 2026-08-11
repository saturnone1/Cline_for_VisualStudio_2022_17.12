import { beforeEach, describe, expect, it, vi } from "vitest";

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }));

vi.mock("../config/platform.config", () => ({
	PLATFORM_CONFIG: {
		encodeMessage: (value: unknown) => value,
		decodeMessage: (value: unknown, decoder: (record: Record<string, unknown>) => unknown) =>
			decoder(value as Record<string, unknown>),
		postMessage,
		rpcUnaryTimeoutMs: 120_000,
	},
}));

vi.mock("./generated/WebviewRpcContract", () => ({
	validateWebviewRpcPayload: () => ({ ok: true }),
	WEBVIEW_RPC_PROTOCOL_VERSION: 2,
}));

import { ProtoBusClient } from "./grpcClientBase";

class TestClient extends ProtoBusClient {
	static serviceName = "TestService";
}

function response(requestId: string, message: unknown, isStreaming = false) {
	window.dispatchEvent(
		new MessageEvent("message", {
			data: {
				protocol_version: 2,
				type: "grpc_response",
				grpc_response: {
					request_id: requestId,
					message,
					is_streaming: isStreaming,
				},
			},
		}),
	);
}

describe("ProtoBusClient failure boundaries", () => {
	beforeEach(() => postMessage.mockClear());

	it("rejects a unary request when response decoding fails", async () => {
		const request = TestClient.makeUnaryRequest(
			"decode",
			{},
			(value) => value,
			() => {
				throw new Error("decoder failed");
			},
		);
		const requestId = postMessage.mock.calls[0][0].grpc_request.request_id;

		response(requestId, {});

		await expect(request).rejects.toThrow("decoder failed");
	});

	it("closes a stream and reports callback failures once", () => {
		const onError = vi.fn();
		TestClient.makeStreamingRequest(
			"stream",
			{},
			(value) => value,
			(value) => value,
			{
				onResponse: () => {
					throw new Error("consumer failed");
				},
				onError,
				onComplete: vi.fn(),
			},
		);
		const requestId = postMessage.mock.calls[0][0].grpc_request.request_id;

		response(requestId, { value: 1 }, true);
		response(requestId, { value: 2 }, true);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0]).toMatchObject({
			message: "consumer failed",
		});
	});

	it("routes concurrent responses only to their matching request", async () => {
		const first = TestClient.makeUnaryRequest("first", {}, (value) => value, (value) => value.value);
		const second = TestClient.makeUnaryRequest("second", {}, (value) => value, (value) => value.value);
		const firstId = postMessage.mock.calls[0][0].grpc_request.request_id;
		const secondId = postMessage.mock.calls[1][0].grpc_request.request_id;

		response(secondId, { value: "second" });
		response(firstId, { value: "first" });
		await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
	});

	it("allows explicitly long-running unary operations to opt out of the client deadline", async () => {
		vi.useFakeTimers();
		try {
			const request = TestClient.makeUnaryRequest("compact", {}, (value) => value, (value) => value.value, 0);
			const requestId = postMessage.mock.calls[0][0].grpc_request.request_id;
			await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
			response(requestId, { value: "completed" });
			await expect(request).resolves.toBe("completed");
		} finally {
			vi.useRealTimers();
		}
	});
});
