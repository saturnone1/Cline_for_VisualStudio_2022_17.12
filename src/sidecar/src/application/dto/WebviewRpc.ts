export type GrpcRequest = {
	service?: string
	method?: string
	request_id?: string
	requestId?: string
	is_streaming?: boolean
	isStreaming?: boolean
	message?: unknown
}

export type WebviewEnvelope = {
	type?: string
	grpc_request?: GrpcRequest
	grpc_request_cancel?: { request_id?: string }
}
