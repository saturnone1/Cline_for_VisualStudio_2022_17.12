import { inferLocalModelImageSupport } from "./providerUtils"

describe("inferLocalModelImageSupport", () => {
	it("does not advertise text-only local models as multimodal", () => {
		expect(inferLocalModelImageSupport("openai/gpt-oss-120b")).toBe(false)
		expect(inferLocalModelImageSupport("deepseek-r1:70b")).toBe(false)
	})

	it("recognizes common multimodal local model families", () => {
		expect(inferLocalModelImageSupport("llama3.2-vision:11b")).toBe(true)
		expect(inferLocalModelImageSupport("qwen2.5-vl:7b")).toBe(true)
		expect(inferLocalModelImageSupport("gemma3:12b")).toBe(true)
	})
})
