import { createProtoStub } from "../protoStub"

export type Boolean = { value: boolean }
export const Boolean = createProtoStub<Boolean>("Boolean")

export type BooleanRequest = { value?: boolean }
export const BooleanRequest = createProtoStub<BooleanRequest>("BooleanRequest")

export type EmptyRequest = Record<string, never>
export const EmptyRequest = createProtoStub<EmptyRequest>("EmptyRequest")

export type Int64Request = { value: number }
export const Int64Request = createProtoStub<Int64Request>("Int64Request")

export type StringArrayRequest = { value: string[] }
export const StringArrayRequest = createProtoStub<StringArrayRequest>("StringArrayRequest")

export type StringRequest = { value: string }
export const StringRequest = createProtoStub<StringRequest>("StringRequest")
