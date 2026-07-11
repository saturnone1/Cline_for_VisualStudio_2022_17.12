import { createProtoStub } from "../protoStub"
import type { ModelInfo } from "../../api"

export type McpDisplayMode = "RICH" | "PLAIN" | "MARKDOWN"
export const McpDisplayMode = {
	RICH: "RICH",
	PLAIN: "PLAIN",
	MARKDOWN: "MARKDOWN",
} as const satisfies Record<string, McpDisplayMode>

export type OnboardingModel = {
	id: string
	name: string
	description?: string
	group: string
	badge: string
	score: number
	latency: number
	info?: ModelInfo
}
export const OnboardingModel = createProtoStub<OnboardingModel>("OnboardingModel")

export type OnboardingModelGroup = { models: OnboardingModel[] }
export const OnboardingModelGroup = createProtoStub<OnboardingModelGroup>("OnboardingModelGroup")

export type PlanActMode = "PLAN" | "ACT"
export const PlanActMode = {
	PLAN: "PLAN",
	ACT: "ACT",
} as const satisfies Record<string, PlanActMode>

export type ResetStateRequest = { global?: boolean }
export const ResetStateRequest = createProtoStub<ResetStateRequest>("ResetStateRequest")

export type TelemetrySettingEnum = "UNSET" | "ENABLED" | "DISABLED"
export const TelemetrySettingEnum = {
	UNSET: "UNSET",
	ENABLED: "ENABLED",
	DISABLED: "DISABLED",
} as const satisfies Record<string, TelemetrySettingEnum>

export type TelemetrySettingRequest = { setting: TelemetrySettingEnum }
export const TelemetrySettingRequest = createProtoStub<TelemetrySettingRequest>("TelemetrySettingRequest")

export type TerminalProfile = {
	id: string
	name: string
	description?: string
	path?: string
	shellPath?: string
	args?: string[]
}
export const TerminalProfile = createProtoStub<TerminalProfile>("TerminalProfile")

export type TogglePlanActModeRequest = {
	mode: PlanActMode
	chatContent?: {
		message?: string
		images?: string[]
		files?: string[]
	}
}
export const TogglePlanActModeRequest = createProtoStub<TogglePlanActModeRequest>("TogglePlanActModeRequest")

export type UpdateSettingsRequest = Record<string, unknown>
export const UpdateSettingsRequest = createProtoStub<UpdateSettingsRequest>("UpdateSettingsRequest")
