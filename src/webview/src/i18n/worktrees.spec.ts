import { describe, expect, it } from "vitest"
import { translate } from "."

describe("worktree i18n", () => {
	it("renders worktree entry points in Korean", () => {
		expect(translate("ko", "worktrees.title")).toBe("워크트리")
		expect(translate("ko", "worktrees.new")).toBe("새 워크트리")
		expect(translate("ko", "worktrees.chooseSolution")).toBe("솔루션 선택")
		expect(translate("ko", "worktrees.mergeInto", { branch: "main" })).toBe("main에 병합")
	})

	it("renders worktree entry points in English", () => {
		expect(translate("en", "worktrees.title")).toBe("Worktrees")
		expect(translate("en", "worktrees.new")).toBe("New Worktree")
		expect(translate("en", "worktrees.chooseSolution")).toBe("Choose Solution")
		expect(translate("en", "worktrees.mergeInto", { branch: "main" })).toBe("Merge into main")
	})
})
