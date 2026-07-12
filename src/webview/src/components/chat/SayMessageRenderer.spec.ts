import { getProgressRowTitle, isCompletedProgressTitle, isEmptyJsonPlaceholder } from "./SayMessageRenderer"

describe("say message progress policy", () => {
	it("normalizes streaming and completed progress titles", () => {
		expect(getProgressRowTitle("터미널 실행 진행 중: dotnet build", true)).toBe("터미널 실행 진행 중")
		expect(getProgressRowTitle("Searches: agent", false)).toBe("검색 기록")
	})

	it("suppresses empty payload placeholders and terminal history markers", () => {
		expect(isEmptyJsonPlaceholder(" {} ")).toBe(true)
		expect(isEmptyJsonPlaceholder("actual response")).toBe(false)
		expect(isCompletedProgressTitle("응답 준비 기록")).toBe(true)
	})
})
