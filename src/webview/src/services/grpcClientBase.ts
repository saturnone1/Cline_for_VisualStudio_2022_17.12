/** biome-ignore-all lint/complexity/noThisInStatic: In static methods, this refers to the constructor (the subclass that invoked the method) when we want to refer to the subclass serviceName.
 *
 * NOTE: This file imports PLATFORM_CONFIG directly rather than using the PlatformProvider
 * because it contains static utility methods that are called from various contexts,
 * including non-React code. The configuration is compile-time constant, so direct
 * import is safe and ensures the methods work consistently regardless of React context.
 */
import { PLATFORM_CONFIG } from "../config/platform.config"

const WEBVIEW_RPC_PROTOCOL_VERSION = 1 as const

export interface Callbacks<TResponse> {
	onResponse: (response: TResponse) => void
	onError: (error: Error) => void
	onComplete: () => void
}

export abstract class ProtoBusClient {
	static serviceName: string

	private static createRequestId(): string {
		if (typeof globalThis.crypto?.randomUUID === "function") {
			return globalThis.crypto.randomUUID()
		}

		return `vscline-${Date.now()}-${Math.random().toString(16).slice(2)}`
	}

	static async makeUnaryRequest<TRequest, TResponse>(
		methodName: string,
		request: TRequest,
		encodeRequest: (_: TRequest) => unknown,
		decodeResponse: (value: Record<string, unknown>) => TResponse,
	): Promise<TResponse> {
		return new Promise((resolve, reject) => {
			const requestId = this.createRequestId()
			let closed = false
			const cleanup = () => {
				if (closed) {
					return
				}
				closed = true
				window.removeEventListener("message", handleResponse)
				window.clearTimeout(timeout)
			}
			const cancelHostRequest = () => {
				PLATFORM_CONFIG.postMessage({
					protocol_version: WEBVIEW_RPC_PROTOCOL_VERSION,
					type: "grpc_request_cancel",
					grpc_request_cancel: {
						request_id: requestId,
					},
				})
			}
			const timeout = window.setTimeout(() => {
				cancelHostRequest()
				cleanup()
				reject(new Error(`Timed out waiting for ${this.serviceName}.${methodName}`))
			}, 120_000)

			// Set up one-time listener for this specific request
			const handleResponse = (event: MessageEvent<unknown>) => {
				if (closed) {
					return
				}
				const response = parseGrpcResponse(event.data, requestId)
				if (response) {
					// Remove listener once we get our response
					cleanup()
					if (response.message) {
						resolve(PLATFORM_CONFIG.decodeMessage(response.message, decodeResponse))
					} else if (response.error) {
						reject(new Error(response.error))
					} else {
						resolve(PLATFORM_CONFIG.decodeMessage({}, decodeResponse))
					}
				}
			}

			window.addEventListener("message", handleResponse)
			PLATFORM_CONFIG.postMessage({
				protocol_version: WEBVIEW_RPC_PROTOCOL_VERSION,
				type: "grpc_request",
				grpc_request: {
					service: this.serviceName,
					method: methodName,
					message: PLATFORM_CONFIG.encodeMessage(request, encodeRequest),
					request_id: requestId,
					is_streaming: false,
				},
			})
		})
	}

	static makeStreamingRequest<TRequest, TResponse>(
		methodName: string,
		request: TRequest,
		encodeRequest: (_: TRequest) => unknown,
		decodeResponse: (value: Record<string, unknown>) => TResponse,
		callbacks: Callbacks<TResponse>,
	): () => void {
		const requestId = this.createRequestId()
		let closed = false
		const cleanup = () => {
			if (closed) {
				return false
			}
			closed = true
			window.removeEventListener("message", handleResponse)
			return true
		}
		// Set up listener for streaming responses
		const handleResponse = (event: MessageEvent<unknown>) => {
			if (closed) {
				return
			}
			const response = parseGrpcResponse(event.data, requestId)
			if (response) {
				if (response.message) {
					// Process streaming message
					callbacks.onResponse(PLATFORM_CONFIG.decodeMessage(response.message, decodeResponse))
				} else if (response.error) {
					// Handle error
					if (callbacks.onError) {
						callbacks.onError(new Error(response.error))
					}
					cleanup()
				} else {
					console.error("Received ProtoBus message with no response or error ", JSON.stringify(event.data))
				}
				if (response.isStreaming === false) {
					if (callbacks.onComplete) {
						callbacks.onComplete()
					}
					cleanup()
				}
			}
		}
		window.addEventListener("message", handleResponse)
		PLATFORM_CONFIG.postMessage({
			protocol_version: WEBVIEW_RPC_PROTOCOL_VERSION,
			type: "grpc_request",
			grpc_request: {
				service: this.serviceName,
				method: methodName,
				message: PLATFORM_CONFIG.encodeMessage(request, encodeRequest),
				request_id: requestId,
				is_streaming: true,
			},
		})
		// Return a function to cancel the stream
		return () => {
			if (!cleanup()) {
				return
			}
			PLATFORM_CONFIG.postMessage({
				protocol_version: WEBVIEW_RPC_PROTOCOL_VERSION,
				type: "grpc_request_cancel",
				grpc_request_cancel: {
					request_id: requestId,
				},
			})
		}
	}
}

type GrpcResponse = Readonly<{ message?: unknown; error?: string; isStreaming: boolean }>

function parseGrpcResponse(value: unknown, requestId: string): GrpcResponse | null {
	const envelope = asRecord(value)
	if (envelope.protocol_version !== WEBVIEW_RPC_PROTOCOL_VERSION || envelope.type !== "grpc_response") return null
	const response = asRecord(envelope.grpc_response)
	if (response.request_id !== requestId || typeof response.is_streaming !== "boolean") return null
	return {
		...(response.message !== undefined ? { message: response.message } : {}),
		...(typeof response.error === "string" ? { error: response.error } : {}),
		isStreaming: response.is_streaming,
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
