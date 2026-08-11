import { HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION } from "../../application/dto/WebviewRpc"

export function grpcHandled(...webviewMessages: unknown[]) {
	return { handled: true, owner: "sidecar", webviewMessages }
}

export function grpcResponse(requestId: string, message: unknown, isStreaming: boolean) {
	return {
		protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION,
		type: "grpc_response",
		grpc_response: { request_id: requestId, message, is_streaming: isStreaming },
	}
}

export function grpcError(requestId: string, error: string, isStreaming: boolean) {
	return {
		protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION,
		type: "grpc_response",
		grpc_response: { request_id: requestId, error, is_streaming: isStreaming },
	}
}
