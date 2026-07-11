import { createProtoStub } from "./protoStub"

export type CreateHookRequest = any
export const CreateHookRequest = createProtoStub("CreateHookRequest")

export type CreateSkillRequest = any
export const CreateSkillRequest = createProtoStub("CreateSkillRequest")

export type DeleteSkillRequest = any
export const DeleteSkillRequest = createProtoStub("DeleteSkillRequest")

export { EmptyRequest } from "./cline/common"

export type OcaAuthState = any
export const OcaAuthState = createProtoStub("OcaAuthState")

export type OcaUserInfo = any
export const OcaUserInfo = createProtoStub("OcaUserInfo")

export { OnboardingModel, OnboardingModelGroup } from "./cline/state"

export type OpenRouterModelInfo = any
export const OpenRouterModelInfo = createProtoStub("OpenRouterModelInfo")

export type RuleFileRequest = any
export const RuleFileRequest = createProtoStub("RuleFileRequest")

export type SapAiCoreModelDeployment = any
export const SapAiCoreModelDeployment = createProtoStub("SapAiCoreModelDeployment")

export type SapAiCoreModelsRequest = any
export const SapAiCoreModelsRequest = createProtoStub("SapAiCoreModelsRequest")

export { StringRequest } from "./cline/common"

export type UpdateApiConfigurationRequestNew = any
export const UpdateApiConfigurationRequestNew = createProtoStub("UpdateApiConfigurationRequestNew")

export { UpdateSettingsRequest } from "./cline/state"

export type UpdateTerminalConnectionTimeoutResponse = any
export const UpdateTerminalConnectionTimeoutResponse = createProtoStub("UpdateTerminalConnectionTimeoutResponse")

export { UserOrganization } from "./cline/account"
