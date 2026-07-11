import { createProtoStub } from "../protoStub"

type ToggleMap = Record<string, boolean>
type HookInfo = { name: string; enabled: boolean; absolutePath: string }
type WorkspaceHooks = { workspaceName: string; hooks: HookInfo[] }

export type ClineRulesToggles = { toggles?: ToggleMap }
export const ClineRulesToggles = createProtoStub<ClineRulesToggles>("ClineRulesToggles")

export type DeleteHookRequest = { hookName: string; isGlobal: boolean; workspaceName?: string }
export const DeleteHookRequest = createProtoStub<DeleteHookRequest>("DeleteHookRequest")

export type FileInfo = {
	path: string
	type: "file" | "folder"
	label?: string
	workspaceName?: string
}
export const FileInfo = createProtoStub<FileInfo>("FileInfo")

export type FileSearchRequest = {
	query: string
	mentionsRequestId: string
	selectedType?: FileSearchType
	workspaceHint?: string
}
export const FileSearchRequest = createProtoStub<FileSearchRequest>("FileSearchRequest")

export type FileSearchType = "FILE" | "FOLDER"
export const FileSearchType = {
	FILE: "FILE",
	FOLDER: "FOLDER",
} as const satisfies Record<string, FileSearchType>

export type HooksToggles = { globalHooks?: HookInfo[]; workspaceHooks?: WorkspaceHooks[] }
export const HooksToggles = createProtoStub<HooksToggles>("HooksToggles")

export type RefreshedRules = {
	globalClineRulesToggles?: ClineRulesToggles
	localClineRulesToggles?: ClineRulesToggles
	localCursorRulesToggles?: ClineRulesToggles
	localWindsurfRulesToggles?: ClineRulesToggles
	localAgentsRulesToggles?: ClineRulesToggles
	localWorkflowToggles?: ClineRulesToggles
	globalWorkflowToggles?: ClineRulesToggles
}
export const RefreshedRules = createProtoStub<RefreshedRules>("RefreshedRules")

export type RelativePathsRequest = { uris: string[] }
export const RelativePathsRequest = createProtoStub<RelativePathsRequest>("RelativePathsRequest")

export type RuleScope = "GLOBAL" | "LOCAL" | "REMOTE"
export const RuleScope = {
	GLOBAL: "GLOBAL",
	LOCAL: "LOCAL",
	REMOTE: "REMOTE",
} as const satisfies Record<string, RuleScope>

export type SkillInfo = { name: string; path: string; enabled: boolean; alwaysEnabled?: boolean }
export const SkillInfo = createProtoStub<SkillInfo>("SkillInfo")

export type ToggleAgentsRuleRequest = { rulePath: string; enabled: boolean }
export const ToggleAgentsRuleRequest = createProtoStub<ToggleAgentsRuleRequest>("ToggleAgentsRuleRequest")

export type ToggleClineRuleRequest = { scope: RuleScope; rulePath: string; enabled: boolean }
export const ToggleClineRuleRequest = createProtoStub<ToggleClineRuleRequest>("ToggleClineRuleRequest")

export type ToggleCursorRuleRequest = { rulePath: string; enabled: boolean }
export const ToggleCursorRuleRequest = createProtoStub<ToggleCursorRuleRequest>("ToggleCursorRuleRequest")

export type ToggleSkillRequest = { skillPath: string; isGlobal: boolean; enabled: boolean }
export const ToggleSkillRequest = createProtoStub<ToggleSkillRequest>("ToggleSkillRequest")

export type ToggleWindsurfRuleRequest = { rulePath: string; enabled: boolean }
export const ToggleWindsurfRuleRequest = createProtoStub<ToggleWindsurfRuleRequest>("ToggleWindsurfRuleRequest")

export type ToggleWorkflowRequest = { workflowPath: string; enabled: boolean; scope: RuleScope }
export const ToggleWorkflowRequest = createProtoStub<ToggleWorkflowRequest>("ToggleWorkflowRequest")
