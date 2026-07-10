import type { Callbacks } from "./grpcClientBase"
import { ProtoBusClient } from "./grpcClientBase"

const encodeMessage = <TRequest>(request: TRequest) => request
const decodeMessage = <TResponse>(response: TResponse) => response

const isStreamingCallbacks = (value: unknown): value is Callbacks<unknown> =>
	!!value &&
	typeof value === "object" &&
	("onResponse" in value || "onError" in value || "onComplete" in value)

const createServiceClient = (serviceName: string) => {
	class DynamicProtoBusClient extends ProtoBusClient {
		static serviceName = serviceName
	}

	return new Proxy(DynamicProtoBusClient as any, {
		get(target, property, receiver) {
			if (typeof property !== "string" || property in target) {
				return Reflect.get(target, property, receiver)
			}

			return (request: unknown = {}, callbacks?: Callbacks<unknown>) => {
				if (isStreamingCallbacks(callbacks)) {
					return target.makeStreamingRequest(property, request, encodeMessage, decodeMessage, callbacks)
				}

				return target.makeUnaryRequest(property, request, encodeMessage, decodeMessage)
			}
		},
	})
}

export const AccountServiceClient: any = createServiceClient("AccountService")
export const BrowserServiceClient: any = createServiceClient("BrowserService")
export const CheckpointsServiceClient: any = createServiceClient("CheckpointsService")
export const FileServiceClient: any = createServiceClient("FileService")
export const McpServiceClient: any = createServiceClient("McpService")
export const ModelsServiceClient: any = createServiceClient("ModelsService")
export const OcaAccountServiceClient: any = createServiceClient("OcaAccountService")
export const SlashServiceClient: any = createServiceClient("SlashService")
export const StateServiceClient: any = createServiceClient("StateService")
export const TaskServiceClient: any = createServiceClient("TaskService")
export const UiServiceClient: any = createServiceClient("UiService")
export const WebServiceClient: any = createServiceClient("WebService")
export const WorktreeServiceClient: any = createServiceClient("WorktreeService")
