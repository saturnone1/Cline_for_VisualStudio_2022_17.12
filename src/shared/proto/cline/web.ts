import { createProtoStub } from "../protoStub"

export type OpenGraphData = {
	title: string
	description: string
	image: string
	url: string
	siteName: string
	type: string
}
export const OpenGraphData = createProtoStub<OpenGraphData>("OpenGraphData")
