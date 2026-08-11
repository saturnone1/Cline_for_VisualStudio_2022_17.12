import { createProtoStub } from "./protoStub"

export type CreateHookRequest = { hookName: string; isGlobal: boolean; workspaceName?: string }
export const CreateHookRequest = createProtoStub<CreateHookRequest>("CreateHookRequest")

export type CreateSkillRequest = { skillName: string; isGlobal: boolean }
export const CreateSkillRequest = createProtoStub<CreateSkillRequest>("CreateSkillRequest")

export type DeleteSkillRequest = { skillPath: string; isGlobal: boolean }
export const DeleteSkillRequest = createProtoStub<DeleteSkillRequest>("DeleteSkillRequest")

export { EmptyRequest } from "./cline/common"

export type OcaAuthState = { user?: OcaUserInfo }
export const OcaAuthState = createProtoStub<OcaAuthState>("OcaAuthState")

export type OcaUserInfo = { uid: string; email?: string; displayName?: string; photoUrl?: string }
export const OcaUserInfo = createProtoStub<OcaUserInfo>("OcaUserInfo")

export { OnboardingModel, OnboardingModelGroup } from "./cline/state"

export { OpenRouterModelInfo } from "./cline/models"

export type RuleFileRequest = { isGlobal: boolean; filename?: string; rulePath?: string; type?: string }
export const RuleFileRequest = createProtoStub<RuleFileRequest>("RuleFileRequest")

export type SapAiCoreModelDeployment = { modelName: string; deploymentId: string }
export const SapAiCoreModelDeployment = createProtoStub<SapAiCoreModelDeployment>("SapAiCoreModelDeployment")

export type SapAiCoreModelsRequest = {
	clientId: string
	clientSecret: string
	baseUrl: string
	tokenUrl: string
	resourceGroup?: string
}
export const SapAiCoreModelsRequest = createProtoStub<SapAiCoreModelsRequest>("SapAiCoreModelsRequest")

export { StringRequest } from "./cline/common"

export type UpdateApiConfigurationRequestNew = {
	updates: { options?: Record<string, unknown>; secrets?: Record<string, unknown> }
	updateMask: string[]
}
export const UpdateApiConfigurationRequestNew = createProtoStub<UpdateApiConfigurationRequestNew>("UpdateApiConfigurationRequestNew")

export { UpdateSettingsRequest } from "./cline/state"

export type UpdateTerminalConnectionTimeoutResponse = { timeoutMs?: number }
export const UpdateTerminalConnectionTimeoutResponse = createProtoStub<UpdateTerminalConnectionTimeoutResponse>("UpdateTerminalConnectionTimeoutResponse")

export { UserOrganization } from "./cline/account"
