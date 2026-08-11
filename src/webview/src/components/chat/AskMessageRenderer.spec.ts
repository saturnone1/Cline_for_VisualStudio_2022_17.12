import { parseAskQuestion, parsePlanResponse } from "./AskMessageRenderer"

describe("ask message parsing", () => {
	it("accepts structured follow-up and plan responses", () => {
		expect(parseAskQuestion('{"question":"Continue?","options":["Yes"]}')).toMatchObject({ question: "Continue?", options: ["Yes"] })
		expect(parsePlanResponse('{"response":"Plan ready","selected":"Approve"}')).toMatchObject({ response: "Plan ready", selected: "Approve" })
	})

	it("preserves legacy plain-text payloads", () => {
		expect(parseAskQuestion("Legacy question").question).toBe("Legacy question")
		expect(parsePlanResponse("Legacy plan").response).toBe("Legacy plan")
	})
})
