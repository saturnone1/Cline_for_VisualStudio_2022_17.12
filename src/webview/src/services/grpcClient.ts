import type { Callbacks } from "./grpcClientBase"
import { ProtoBusClient } from "./grpcClientBase"

const encodeMessage = <TRequest>(request: TRequest) => request
const decodeMessage = <TResponse>(response: TResponse) => response

type RpcRequest = Record<string, unknown>
type EmptyResponse = Record<string, never>
type PartialMessageEvent = RpcRequest & { ts?: number }
type ShowWebviewEvent = RpcRequest & { preserveEditorFocus?: boolean }
type AddToInputEvent = RpcRequest & { value?: string }
type UnaryOperation<TRequest extends RpcRequest = RpcRequest, TResponse = EmptyResponse> = (request: TRequest) => Promise<TResponse>
type StreamingOperation<TResponse, TRequest extends RpcRequest = RpcRequest> = (
	request: TRequest,
	callbacks: Callbacks<TResponse>,
) => () => void

interface UiServiceContract {
	initializeWebview: UnaryOperation
	onDidShowAnnouncement: UnaryOperation
	openUrl: UnaryOperation<RpcRequest>
	openWalkthrough: UnaryOperation
	setTerminalExecutionMode: UnaryOperation<RpcRequest>
	subscribeToMcpButtonClicked: StreamingOperation<EmptyResponse>
	subscribeToHistoryButtonClicked: StreamingOperation<EmptyResponse>
	subscribeToChatButtonClicked: StreamingOperation<EmptyResponse>
	subscribeToSettingsButtonClicked: StreamingOperation<EmptyResponse>
	subscribeToWorktreesButtonClicked: StreamingOperation<EmptyResponse>
	subscribeToAccountButtonClicked: StreamingOperation<EmptyResponse>
	subscribeToRelinquishControl: StreamingOperation<EmptyResponse>
	subscribeToPartialMessage: StreamingOperation<PartialMessageEvent>
	subscribeToShowWebview: StreamingOperation<ShowWebviewEvent>
	subscribeToAddToInput: StreamingOperation<AddToInputEvent>
}

interface CheckpointsServiceContract {
	checkpointRestore: UnaryOperation<RpcRequest>
	checkpointDiff: UnaryOperation<RpcRequest>
}

interface SlashServiceContract {
	condense: UnaryOperation<RpcRequest>
	reportBug: UnaryOperation<RpcRequest>
}

interface BrowserConnectionInfoResponse extends RpcRequest {
	isConnected: boolean
	isRemote: boolean
	host?: string
	path?: string
	browser?: string
	protocolVersion?: string
	tabCount?: number
	activeTabTitle?: string
	activeTabUrl?: string
	error?: string
}

interface BrowserProbeResponse extends RpcRequest {
	success: boolean
	message?: string
	host?: string
	browser?: string
	tabCount?: number
	activeTabTitle?: string
}

interface BrowserServiceContract {
	getBrowserConnectionInfo: UnaryOperation<RpcRequest, BrowserConnectionInfoResponse>
	getDetectedChromePath: UnaryOperation<RpcRequest, RpcRequest & { path?: string; isBundled?: boolean }>
	testBrowserConnection: UnaryOperation<RpcRequest, BrowserProbeResponse>
	discoverBrowser: UnaryOperation<RpcRequest, BrowserProbeResponse>
	relaunchChromeDebugMode: UnaryOperation<RpcRequest, RpcRequest & { value: string }>
}

interface OpenGraphResponse extends RpcRequest {
	title?: string
	description?: string
	image?: string
	url?: string
	siteName?: string
	type?: string
}

interface WebServiceContract {
	fetchOpenGraphData: UnaryOperation<RpcRequest, OpenGraphResponse>
	checkIsImageUrl: UnaryOperation<RpcRequest, RpcRequest & { isImage: boolean }>
	openInBrowser: UnaryOperation<RpcRequest>
}

interface OcaAuthStateEvent extends RpcRequest {
	user?: RpcRequest & { uid?: string }
}

interface OcaAccountServiceContract {
	ocaAccountLoginClicked: UnaryOperation
	ocaAccountLogoutClicked: UnaryOperation
	ocaSubscribeToAuthStatusUpdate: StreamingOperation<OcaAuthStateEvent>
}

interface WorktreeInfo extends RpcRequest {
	path: string
	branch?: string
	isBare?: boolean
	isCurrent?: boolean
}

interface WorktreeMutationResponse extends RpcRequest {
	success: boolean
	message?: string
	warning?: string
	worktree?: WorktreeInfo
	solutionCandidates?: string[]
}

interface WorktreeMergeResponse extends WorktreeMutationResponse {
	hasConflicts?: boolean
	conflictingFiles: string[]
	recoveryPrompt?: string
	recoveryCommands?: string[]
	sourceWorktreePath?: string
	sourceBranch?: string
	targetWorktreePath?: string
	targetBranch?: string
}

interface WorktreeServiceContract {
	listWorktrees: UnaryOperation<RpcRequest, RpcRequest & {
		worktrees: WorktreeInfo[]
		isGitRepo: boolean
		isMultiRoot: boolean
		isSubfolder: boolean
		gitRootPath?: string
		errorKind?: string
		error?: string
	}>
	getWorktreeIncludeStatus: UnaryOperation<RpcRequest, RpcRequest & { exists: boolean; hasGitignore: boolean; gitignoreContent: string }>
	createWorktreeInclude: UnaryOperation<RpcRequest, WorktreeMutationResponse>
	getWorktreeDefaults: UnaryOperation<RpcRequest, RpcRequest & {
		suggestedBranch: string
		suggestedPath: string
		baseBranch?: string
		currentBranch?: string
		branches?: string[]
		baseBranches?: string[]
	}>
	createWorktree: UnaryOperation<RpcRequest, WorktreeMutationResponse>
	deleteWorktree: UnaryOperation<RpcRequest, WorktreeMutationResponse>
	switchWorktree: UnaryOperation<RpcRequest, WorktreeMutationResponse>
	mergeWorktree: UnaryOperation<RpcRequest, WorktreeMergeResponse>
	trackWorktreeViewOpened: UnaryOperation<RpcRequest>
}

const isStreamingCallbacks = (value: unknown): value is Callbacks<unknown> =>
	!!value &&
	typeof value === "object" &&
	("onResponse" in value || "onError" in value || "onComplete" in value)

const createServiceClient = <TContract>(serviceName: string): TContract => {
	class DynamicProtoBusClient extends ProtoBusClient {
		static serviceName = serviceName
	}

	return new Proxy(DynamicProtoBusClient, {
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
	}) as unknown as TContract
}

export const AccountServiceClient: any = createServiceClient("AccountService")
export const BrowserServiceClient = createServiceClient<BrowserServiceContract>("BrowserService")
export const CheckpointsServiceClient = createServiceClient<CheckpointsServiceContract>("CheckpointsService")
export const FileServiceClient: any = createServiceClient("FileService")
export const McpServiceClient: any = createServiceClient("McpService")
export const ModelsServiceClient: any = createServiceClient("ModelsService")
export const OcaAccountServiceClient = createServiceClient<OcaAccountServiceContract>("OcaAccountService")
export const SlashServiceClient = createServiceClient<SlashServiceContract>("SlashService")
export const StateServiceClient: any = createServiceClient("StateService")
export const TaskServiceClient: any = createServiceClient("TaskService")
export const UiServiceClient = createServiceClient<UiServiceContract>("UiService")
export const WebServiceClient = createServiceClient<WebServiceContract>("WebService")
export const WorktreeServiceClient = createServiceClient<WorktreeServiceContract>("WorktreeService")
