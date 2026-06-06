import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { filterVisibleMessages, groupLowStakesTools, isToolGroup } from "./messageUtils"

const createTextMessage = (ts: number, text: string): ClineMessage => ({
	type: "say",
	say: "text",
	text,
	ts,
})

const createToolMessage = (ts: number, tool: string): ClineMessage => ({
	type: "say",
	say: "tool",
	text: JSON.stringify({ tool, path: "src/file.ts" }),
	ts,
})

const createReasoningMessage = (ts: number, text: string): ClineMessage => ({
	type: "say",
	say: "reasoning",
	text,
	ts,
})

const createApiRequestMessage = (ts: number, request: string): ClineMessage => ({
	type: "say",
	say: "api_req_started",
	text: JSON.stringify({ request, tokensIn: 0, tokensOut: 0, cost: 0 }),
	ts,
})

describe("filterVisibleMessages", () => {
	it("keeps folded SDK progress summaries that contain user-visible tool activity", () => {
		const visible = filterVisibleMessages([
			createApiRequestMessage(1, "LIG VS read 2 files, ran 1 command:\nFiles:\n- Program.cs\nCommands:\n- dotnet build"),
		])

		expect(visible).toHaveLength(1)
		expect(visible[0]).toMatchObject({ type: "say", say: "api_req_started" })
	})

	it("hides internal SDK iteration and empty model-progress placeholders", () => {
		const visible = filterVisibleMessages([
			createApiRequestMessage(1, "Cline SDK iteration 4 started."),
			createApiRequestMessage(2, "모델 진행 기록"),
		])

		expect(visible).toHaveLength(0)
	})

	it("hides completed empty reasoning placeholders", () => {
		const visible = filterVisibleMessages([
			{
				...createReasoningMessage(1, "파일 읽기 기록"),
				reasoning: "{}",
				partial: false,
			},
			createReasoningMessage(2, "실제 파일 읽기 내용"),
		])

		expect(visible).toHaveLength(1)
		expect(visible[0]).toMatchObject({ type: "say", say: "reasoning", text: "실제 파일 읽기 내용" })
	})
})

describe("groupLowStakesTools", () => {
	it("keeps text that arrives after a low-stakes tool group has started", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "readFile"),
			createTextMessage(3, "Late text that should be shown"),
		])

		expect(grouped).toHaveLength(3)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(isToolGroup(grouped[1])).toBe(true)
		expect(grouped[2]).toMatchObject({ type: "say", say: "text", text: "Late text that should be shown" })
	})

	it("keeps text when no low-stakes tool group is active", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "editedExistingFile"),
			createTextMessage(3, "Follow-up text"),
		])

		expect(grouped).toHaveLength(3)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
		expect(grouped[2]).toMatchObject({ type: "say", say: "text", text: "Follow-up text" })
	})

	it("keeps standalone reasoning when no low-stakes tool group follows", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createTextMessage(2, "Answer text"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "text", text: "Answer text" })
	})

	it("keeps standalone reasoning before a non-low-stakes tool", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createToolMessage(2, "editedExistingFile"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
	})

	it("groups reasoning with a low-stakes tool group that starts immediately after", () => {
		const grouped = groupLowStakesTools([createReasoningMessage(1, "Planning next read"), createToolMessage(2, "readFile")])

		expect(grouped).toHaveLength(1)
		expect(isToolGroup(grouped[0])).toBe(true)
		expect(grouped[0]).toHaveLength(2)
	})
})
