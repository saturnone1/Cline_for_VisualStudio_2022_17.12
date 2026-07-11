export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export type GrpcRequest = {
	service: string
	method: string
	requestId: string
	isStreaming: boolean
	message: JsonObject
}

export type WebviewEnvelope =
	| { type: "grpc_request"; request: GrpcRequest }
	| { type: "grpc_request_cancel"; requestId: string }
	| { type: "unhandled"; originalType: string; message: JsonObject }

export type WebviewEnvelopeParseResult =
	| { ok: true; value: WebviewEnvelope }
	| { ok: false; reason: "invalid_webview_envelope" | "missing_grpc_service" | "missing_grpc_method" | "missing_grpc_request_id" | "missing_cancel_request_id" }

export function parseWebviewEnvelope(value: unknown): WebviewEnvelopeParseResult {
	if (!isJsonObject(value)) {
		return { ok: false, reason: "invalid_webview_envelope" }
	}

	const type = readString(value.type)
	if (type === "grpc_request") {
		if (!isJsonObject(value.grpc_request)) {
			return { ok: false, reason: "invalid_webview_envelope" }
		}

		const request = value.grpc_request
		const service = readString(request.service)
		const method = readString(request.method)
		const requestId = readString(request.request_id) || readString(request.requestId)
		if (!service) return { ok: false, reason: "missing_grpc_service" }
		if (!method) return { ok: false, reason: "missing_grpc_method" }
		if (!requestId) return { ok: false, reason: "missing_grpc_request_id" }

		return {
			ok: true,
			value: {
				type,
				request: {
					service,
					method,
					requestId,
					isStreaming: request.is_streaming === true || request.isStreaming === true,
					message: isJsonObject(request.message) ? request.message : {},
				},
			},
		}
	}

	if (type === "grpc_request_cancel") {
		const cancel = value.grpc_request_cancel
		const requestId = isJsonObject(cancel) ? readString(cancel.request_id) || readString(cancel.requestId) : ""
		return requestId
			? { ok: true, value: { type, requestId } }
			: { ok: false, reason: "missing_cancel_request_id" }
	}

	return { ok: true, value: { type: "unhandled", originalType: type, message: value } }
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: JsonValue | undefined) {
	return typeof value === "string" ? value : ""
}
