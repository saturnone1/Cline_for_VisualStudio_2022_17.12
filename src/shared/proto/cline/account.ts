import { createProtoStub } from "../protoStub"
import type { UsageTransaction as AccountUsageTransaction } from "../../ClineAccount"
import type { UserInfo as SharedUserInfo } from "../../UserInfo"

export type UsageTransaction = Omit<AccountUsageTransaction, "id" | "metadata"> & {
	id?: string
	metadata?: AccountUsageTransaction["metadata"]
}
export const UsageTransaction = createProtoStub<UsageTransaction>("UsageTransaction")

export type UserInfo = SharedUserInfo
export const UserInfo = createProtoStub<UserInfo>("UserInfo")

export type UserOrganization = {
	active: boolean
	memberId?: string
	name: string
	organizationId: string
	roles: string[]
}
export const UserOrganization = createProtoStub<UserOrganization>("UserOrganization")
