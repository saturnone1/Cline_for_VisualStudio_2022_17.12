import { inferLocalModelImageSupport } from "./providerUtils"

describe("inferLocalModelImageSupport", () => {
	it("keeps unverified local model image support unknown instead of blocking attachments", () => {
		expect(inferLocalModelImageSupport("openai/gpt-oss-120b")).toBeUndefined()
		expect(inferLocalModelImageSupport("deepseek-r1:70b")).toBeUndefined()
	})

	it("recognizes common multimodal local model families", () => {
		expect(inferLocalModelImageSupport("llama3.2-vision:11b")).toBe(true)
		expect(inferLocalModelImageSupport("qwen2.5-vl:7b")).toBe(true)
		expect(inferLocalModelImageSupport("gemma3:12b")).toBe(true)
	})
})
