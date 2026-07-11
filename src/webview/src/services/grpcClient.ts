import type { Callbacks } from "./grpcClientBase"
import { ProtoBusClient } from "./grpcClientBase"
import type { PaymentTransaction, UsageTransaction } from "@shared/ClineAccount"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ModelInfo, OcaModelInfo } from "@shared/api"
import type { McpMarketplaceCatalog } from "@shared/mcp"
import type { TerminalProfile } from "@shared/proto/cline/state"

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
	onDidShowAnnouncement: UnaryOperation<RpcRequest, RpcRequest & { value: boolean }>
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

interface AccountUser extends RpcRequest {
	uid: string
	email?: string
	displayName?: string
	photoUrl?: string
	appBaseUrl?: string
}

interface AccountOrganization extends RpcRequest {
	active: boolean
	organizationId: string
	name: string
	memberId?: string
	roles: string[]
}

interface AccountAuthStateEvent extends RpcRequest {
	user?: AccountUser
}

interface AccountCreditsResponse extends RpcRequest {
	balance?: RpcRequest & { currentBalance?: number }
	usageTransactions: UsageTransaction[]
	paymentTransactions: PaymentTransaction[]
}

type AccountAuthActionResponse = RpcRequest & { message?: string }

interface AccountServiceContract {
	accountLoginClicked: UnaryOperation<RpcRequest, AccountAuthActionResponse>
	accountLogoutClicked: UnaryOperation<RpcRequest, AccountAuthActionResponse>
	getUserOrganizations: UnaryOperation<RpcRequest, RpcRequest & { organizations: AccountOrganization[] }>
	subscribeToAuthStatusUpdate: StreamingOperation<AccountAuthStateEvent>
	getUserCredits: UnaryOperation<RpcRequest, AccountCreditsResponse>
	getOrganizationCredits: UnaryOperation<RpcRequest & { organizationId: string }, AccountCreditsResponse>
	setUserOrganization: UnaryOperation<RpcRequest & { organizationId?: string }, AccountAuthActionResponse>
	getRedirectUrl: UnaryOperation<RpcRequest, RpcRequest & { value: string }>
	submitLimitIncreaseRequest: UnaryOperation<RpcRequest, AccountAuthActionResponse>
	hicapAuthClicked: UnaryOperation<RpcRequest, AccountAuthActionResponse>
	openrouterAuthClicked: UnaryOperation<RpcRequest, AccountAuthActionResponse>
	requestyAuthClicked: UnaryOperation<RpcRequest & { value?: string }, AccountAuthActionResponse>
	openAiCodexSignIn: UnaryOperation<RpcRequest, AccountAuthActionResponse>
	openAiCodexSignOut: UnaryOperation<RpcRequest, AccountAuthActionResponse>
}

interface FileSearchResult extends RpcRequest {
	path: string
	type: "file" | "folder"
	value?: string
	label?: string
	description?: string
	workspaceName?: string
}

interface FileCommit extends RpcRequest {
	hash: string
	shortHash: string
	subject: string
	author: string
	date: string
}

interface FileRuleToggleGroup extends RpcRequest {
	toggles?: Record<string, boolean>
}

interface FileRulesResponse extends RpcRequest {
	globalClineRulesToggles?: FileRuleToggleGroup
	localClineRulesToggles?: FileRuleToggleGroup
	localCursorRulesToggles?: FileRuleToggleGroup
	localWindsurfRulesToggles?: FileRuleToggleGroup
	localAgentsRulesToggles?: FileRuleToggleGroup
	localWorkflowToggles?: FileRuleToggleGroup
	globalWorkflowToggles?: FileRuleToggleGroup
}

interface FileHookInfo extends RpcRequest {
	name: string
	enabled: boolean
	absolutePath: string
}

interface WorkspaceHooks extends RpcRequest {
	workspaceName: string
	hooks: FileHookInfo[]
}

interface FileSkillInfo extends RpcRequest {
	name?: string
	path?: string
	enabled?: boolean
	description?: string
}

interface FileServiceContract {
	openImage: UnaryOperation<RpcRequest>
	openFile: UnaryOperation<RpcRequest>
	openFileRelativePath: UnaryOperation<RpcRequest>
	openVsClineDiff: UnaryOperation<RpcRequest>
	revertVsClineChanges: UnaryOperation<RpcRequest>
	copyToClipboard: UnaryOperation<RpcRequest>
	openDiskConversationHistory: UnaryOperation<RpcRequest>
	openFocusChainFile: UnaryOperation<RpcRequest>
	openMention: UnaryOperation<RpcRequest>
	ifFileExistsRelativePath: UnaryOperation<RpcRequest, RpcRequest & { value: boolean }>
	selectFiles: UnaryOperation<RpcRequest, RpcRequest & { values1: string[]; values2: string[] }>
	searchFiles: UnaryOperation<RpcRequest, RpcRequest & { results: FileSearchResult[] }>
	searchCommits: UnaryOperation<RpcRequest, RpcRequest & { commits: FileCommit[] }>
	getRelativePaths: UnaryOperation<RpcRequest, RpcRequest & { paths: string[] }>
	refreshRules: UnaryOperation<RpcRequest, FileRulesResponse>
	refreshHooks: UnaryOperation<RpcRequest, RpcRequest & { globalHooks: FileHookInfo[]; workspaceHooks: WorkspaceHooks[] }>
	refreshSkills: UnaryOperation<RpcRequest, RpcRequest & { globalSkills: FileSkillInfo[]; localSkills: FileSkillInfo[] }>
	toggleClineRule: UnaryOperation<RpcRequest, RpcRequest & {
		globalClineRulesToggles?: FileRuleToggleGroup
		localClineRulesToggles?: FileRuleToggleGroup
		remoteRulesToggles?: FileRuleToggleGroup
	}>
	toggleCursorRule: UnaryOperation<RpcRequest, FileRuleToggleGroup>
	toggleWindsurfRule: UnaryOperation<RpcRequest, FileRuleToggleGroup>
	toggleAgentsRule: UnaryOperation<RpcRequest, FileRuleToggleGroup>
	toggleHook: UnaryOperation<RpcRequest, RpcRequest & {
		hooksToggles?: RpcRequest & { globalHooks?: FileHookInfo[]; workspaceHooks?: WorkspaceHooks[] }
	}>
	toggleWorkflow: UnaryOperation<RpcRequest, FileRuleToggleGroup>
	toggleSkill: UnaryOperation<RpcRequest, RpcRequest & {
		globalSkillsToggles?: Record<string, boolean>
		localSkillsToggles?: Record<string, boolean>
	}>
	createHook: UnaryOperation<RpcRequest>
	deleteHook: UnaryOperation<RpcRequest>
	createRuleFile: UnaryOperation<RpcRequest>
	deleteRuleFile: UnaryOperation<RpcRequest>
	createSkillFile: UnaryOperation<RpcRequest>
	deleteSkillFile: UnaryOperation<RpcRequest>
}

interface RecommendedModel extends RpcRequest {
	id: string
	name?: string
	description: string
	tags: string[]
}

type ProviderModelsResponse = RpcRequest & { models: Record<string, ModelInfo>; error?: string }
type OcaModelsResponse = RpcRequest & { models: Record<string, OcaModelInfo>; error?: string }
type StringModelsResponse = RpcRequest & { values: string[] }

interface ModelsServiceContract {
	refreshClineRecommendedModelsRpc: UnaryOperation<RpcRequest, RpcRequest & {
		recommended: RecommendedModel[]
		free: RecommendedModel[]
	}>
	getOllamaModels: UnaryOperation<RpcRequest, StringModelsResponse>
	getLmStudioModels: UnaryOperation<RpcRequest, StringModelsResponse>
	getAihubmixModels: UnaryOperation<RpcRequest, ProviderModelsResponse>
	getVsCodeLmModels: UnaryOperation<RpcRequest, RpcRequest & { models: RpcRequest[] }>
	getSapAiCoreModels: UnaryOperation<RpcRequest, RpcRequest & {
		deployments: RpcRequest[]
		orchestrationAvailable: boolean
	}>
	refreshOpenRouterModelsRpc: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshHicapModels: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshLiteLlmModelsRpc: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshBasetenModelsRpc: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshVercelAiGatewayModelsRpc: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshClineModelsRpc: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshGroqModelsRpc: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshHuggingFaceModels: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshRequestyModels: UnaryOperation<RpcRequest, ProviderModelsResponse>
	refreshOcaModels: UnaryOperation<RpcRequest, OcaModelsResponse>
	refreshOpenAiModels: UnaryOperation<RpcRequest, ProviderModelsResponse>
	updateApiConfiguration: UnaryOperation<RpcRequest>
	updateApiConfigurationProto: UnaryOperation<RpcRequest>
}

interface StateServiceContract {
	subscribeToState: StreamingOperation<RpcRequest & { stateJson: string }>
	getAvailableTerminalProfiles: UnaryOperation<RpcRequest, RpcRequest & { profiles: TerminalProfile[] }>
	updateSettings: UnaryOperation<RpcRequest>
	updateAutoApprovalSettings: UnaryOperation<RpcRequest>
	togglePlanActModeProto: UnaryOperation<RpcRequest, RpcRequest & { value: boolean }>
	updateTelemetrySetting: UnaryOperation<RpcRequest>
	captureOnboardingProgress: UnaryOperation<RpcRequest>
	setWelcomeViewCompleted: UnaryOperation<RpcRequest>
	toggleFavoriteModel: UnaryOperation<RpcRequest>
	refreshRemoteConfig: UnaryOperation<RpcRequest>
	testOtelConnection: UnaryOperation<RpcRequest, RpcRequest & { success: boolean; error?: string }>
	testPromptUploading: UnaryOperation<RpcRequest, RpcRequest & { success: boolean; error?: string }>
	updateTerminalConnectionTimeout: UnaryOperation<RpcRequest, RpcRequest & { timeoutMs?: number }>
	resetState: UnaryOperation<RpcRequest>
	dismissBanner: UnaryOperation<RpcRequest>
	installClineCli: UnaryOperation<RpcRequest>
	updateCliBannerVersion: UnaryOperation<RpcRequest>
	updateInfoBannerVersion: UnaryOperation<RpcRequest>
	updateModelBannerVersion: UnaryOperation<RpcRequest>
}

interface TaskServiceContract {
	newTask: UnaryOperation<RpcRequest>
	askResponse: UnaryOperation<RpcRequest>
	cancelBackgroundCommand: UnaryOperation<RpcRequest>
	cancelTask: UnaryOperation<RpcRequest>
	clearTask: UnaryOperation<RpcRequest>
	explainChanges: UnaryOperation<RpcRequest>
	taskCompletionViewChanges: UnaryOperation<RpcRequest>
	taskFeedback: UnaryOperation<RpcRequest>
	deleteTasksWithIds: UnaryOperation<RpcRequest>
	showTaskWithId: UnaryOperation<RpcRequest>
	deleteAllTaskHistory: UnaryOperation<RpcRequest>
	getTaskHistory: UnaryOperation<RpcRequest, RpcRequest & { tasks: HistoryItem[] }>
	getTotalTasksSize: UnaryOperation<RpcRequest, RpcRequest & { value: number }>
	toggleTaskFavorite: UnaryOperation<RpcRequest>
	exportTaskWithId: UnaryOperation<RpcRequest>
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

type McpServersResponse = RpcRequest & { mcpServers: RpcRequest[] }

interface McpServiceContract {
	refreshMcpMarketplace: UnaryOperation<RpcRequest, McpMarketplaceCatalog>
	getLatestMcpServers: UnaryOperation<RpcRequest, McpServersResponse>
	addRemoteMcpServer: UnaryOperation<RpcRequest, McpServersResponse>
	downloadMcp: UnaryOperation<RpcRequest, RpcRequest & { error?: string }>
	openMcpSettings: UnaryOperation
	updateMcpTimeout: UnaryOperation<RpcRequest>
	restartMcpServer: UnaryOperation<RpcRequest>
	deleteMcpServer: UnaryOperation<RpcRequest>
	toggleToolAutoApprove: UnaryOperation<RpcRequest>
	toggleMcpServer: UnaryOperation<RpcRequest>
	authenticateMcpServer: UnaryOperation<RpcRequest>
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

export const AccountServiceClient = createServiceClient<AccountServiceContract>("AccountService")
export const BrowserServiceClient = createServiceClient<BrowserServiceContract>("BrowserService")
export const CheckpointsServiceClient = createServiceClient<CheckpointsServiceContract>("CheckpointsService")
export const FileServiceClient = createServiceClient<FileServiceContract>("FileService")
export const McpServiceClient = createServiceClient<McpServiceContract>("McpService")
export const ModelsServiceClient = createServiceClient<ModelsServiceContract>("ModelsService")
export const OcaAccountServiceClient = createServiceClient<OcaAccountServiceContract>("OcaAccountService")
export const SlashServiceClient = createServiceClient<SlashServiceContract>("SlashService")
export const StateServiceClient = createServiceClient<StateServiceContract>("StateService")
export const TaskServiceClient = createServiceClient<TaskServiceContract>("TaskService")
export const UiServiceClient = createServiceClient<UiServiceContract>("UiService")
export const WebServiceClient = createServiceClient<WebServiceContract>("WebService")
export const WorktreeServiceClient = createServiceClient<WorktreeServiceContract>("WorktreeService")
