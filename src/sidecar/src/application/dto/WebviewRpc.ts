export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export const HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION = 1 as const

export type HostSidecarWebviewRequest = {
	protocolVersion: typeof HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION
	rawJson: string
}

export type HostSidecarWebviewResponse = {
	protocolVersion: typeof HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION
	handled: boolean
	reason?: string
	owner?: string
	type?: string
	webviewMessages: JsonValue[]
}

export type HostSidecarWebviewRequestParseResult =
	| { ok: true; value: HostSidecarWebviewRequest }
	| { ok: false; reason: "invalid_host_request" | "unsupported_protocol_version" | "missing_raw_json" }

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
	| { ok: false; reason: "invalid_webview_envelope" | "unsupported_webview_protocol_version" | "missing_grpc_service" | "missing_grpc_method" | "missing_grpc_request_id" | "missing_cancel_request_id" }

export function parseHostSidecarWebviewRequest(value: unknown): HostSidecarWebviewRequestParseResult {
	if (!isJsonObject(value)) {
		return { ok: false, reason: "invalid_host_request" }
	}
	if (value.protocolVersion !== HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION) {
		return { ok: false, reason: "unsupported_protocol_version" }
	}
	if (typeof value.rawJson !== "string" || value.rawJson.length === 0) {
		return { ok: false, reason: "missing_raw_json" }
	}
	return {
		ok: true,
		value: {
			protocolVersion: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION,
			rawJson: value.rawJson,
		},
	}
}

export function createHostSidecarWebviewResponse(value: unknown): HostSidecarWebviewResponse {
	const result = isJsonObject(value) ? value : {}
	return {
		protocolVersion: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION,
		handled: result.handled === true,
		...(typeof result.reason === "string" ? { reason: result.reason } : {}),
		...(typeof result.owner === "string" ? { owner: result.owner } : {}),
		...(typeof result.type === "string" ? { type: result.type } : {}),
		webviewMessages: Array.isArray(result.webviewMessages)
			? result.webviewMessages.map(toJsonValue).filter((message): message is JsonValue => message !== undefined)
			: [],
	}
}

export function parseWebviewEnvelope(value: unknown): WebviewEnvelopeParseResult {
	if (!isJsonObject(value)) {
		return { ok: false, reason: "invalid_webview_envelope" }
	}

	const type = readString(value.type)
	if (type === "grpc_request") {
		if (hasUnsupportedWebviewProtocolVersion(value)) return { ok: false, reason: "unsupported_webview_protocol_version" }
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
		if (hasUnsupportedWebviewProtocolVersion(value)) return { ok: false, reason: "unsupported_webview_protocol_version" }
		const cancel = value.grpc_request_cancel
		const requestId = isJsonObject(cancel) ? readString(cancel.request_id) || readString(cancel.requestId) : ""
		return requestId
			? { ok: true, value: { type, requestId } }
			: { ok: false, reason: "missing_cancel_request_id" }
	}

	return { ok: true, value: { type: "unhandled", originalType: type, message: value } }
}

function hasUnsupportedWebviewProtocolVersion(value: JsonObject) {
	const version = value.protocol_version ?? value.protocolVersion
	return version !== undefined && version !== HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: JsonValue | undefined) {
	return typeof value === "string" ? value : ""
}

function toJsonValue(value: unknown): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number") return Number.isFinite(value) ? value : null
	if (Array.isArray(value)) return value.map((item) => toJsonValue(item) ?? null)
	if (!isUnknownObject(value)) return undefined
	const entries = Object.entries(value)
		.map(([key, item]) => [key, toJsonValue(item)] as const)
		.filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined)
	return Object.fromEntries(entries)
}

function isUnknownObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
