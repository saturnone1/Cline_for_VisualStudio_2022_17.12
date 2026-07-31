import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { filterVisibleMessages, getTaskMessage, groupLowStakesTools, groupMessages, isToolGroup } from "./messageUtils"

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

const createCheckpointMessage = (ts: number): ClineMessage => ({
	type: "say",
	say: "checkpoint_created",
	text: "SDK checkpoint",
	ts,
	checkpointRunCount: ts,
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

	it("hides completed progress title-only reasoning rows", () => {
		const visible = filterVisibleMessages([
			createReasoningMessage(1, "파일/도구 처리 기록"),
			createReasoningMessage(2, "터미널 실행 기록"),
			createReasoningMessage(3, "응답 준비 기록"),
			createTextMessage(4, "실제 답변"),
		])

		expect(visible).toHaveLength(1)
		expect(visible[0]).toMatchObject({ type: "say", say: "text", text: "실제 답변" })
	})

	it("keeps completed reasoning rows when they contain real content", () => {
		const visible = filterVisibleMessages([
			{
				...createReasoningMessage(1, "응답 준비 기록"),
				reasoning: "사용자 요청을 정리하는 중입니다.",
				partial: false,
			},
		])

		expect(visible).toHaveLength(1)
		expect(visible[0]).toMatchObject({ type: "say", say: "reasoning" })
	})

	it("hides raw SDK tool-call markup reasoning rows", () => {
		const visible = filterVisibleMessages([
			createReasoningMessage(1, '<function=mcp-vs2022__document_list> </function> </tool_call>'),
		])

		expect(visible).toHaveLength(0)
	})

	it("hides minimax-style raw tool-call markup reasoning rows", () => {
		const visible = filterVisibleMessages([
			createReasoningMessage(
				1,
				'<function name="run_commands"> <parameter name="commands"> [{"command": "powershell", "args": ["-Command", "[Environment]::GetFolderPath(\'Desktop\')"]}] </parameter> </function> </invoke> </minimax:tool_call>',
			),
		])

		expect(visible).toHaveLength(0)
	})
})

describe("getTaskMessage", () => {
	it("finds the task by message semantics after a migrated leading row", () => {
		const task = { ts: 2, type: "say", say: "task", text: "review" } as ClineMessage
		expect(getTaskMessage([createTextMessage(1, "legacy row"), task])).toBe(task)
	})
})

describe("groupLowStakesTools", () => {
	it("keeps checkpoints visible after a folded tool group", () => {
		const checkpoint = createCheckpointMessage(2)
		const grouped = groupLowStakesTools([createToolMessage(1, "readFile"), checkpoint])

		expect(grouped).toHaveLength(2)
		expect(isToolGroup(grouped[0])).toBe(true)
		expect(grouped[1]).toBe(checkpoint)
	})

	it("keeps checkpoints outside browser session groups", () => {
		const checkpoint = createCheckpointMessage(2)
		const grouped = groupMessages([
			{ type: "say", say: "browser_action_launch", text: "https://example.com", ts: 1 },
			checkpoint,
		])

		expect(grouped).toHaveLength(2)
		expect(Array.isArray(grouped[0])).toBe(true)
		expect(grouped[1]).toBe(checkpoint)
	})

	it("keeps the conversation renderable when a browser event is truncated", () => {
		const grouped = groupMessages([
			{ type: "say", say: "browser_action_launch", text: "https://example.com", ts: 1 },
			{ type: "say", say: "browser_action", text: '{"action":', ts: 2 },
			{ type: "say", say: "browser_action_result", text: "{}", ts: 3 },
		])

		expect(grouped).toHaveLength(2)
		expect(Array.isArray(grouped[0])).toBe(true)
		expect((grouped[0] as ClineMessage[])).toHaveLength(1)
		expect(Array.isArray(grouped[1])).toBe(true)
		expect((grouped[1] as ClineMessage[])).toHaveLength(2)
	})

	it("groups a standalone browser close action with its result and no later chat text", () => {
		const close = { type: "say", say: "browser_action", text: '{"action":"close"}', ts: 1 } as ClineMessage
		const result = { type: "say", say: "browser_action_result", text: '{"status":"closed"}', ts: 2 } as ClineMessage
		const laterText = { type: "say", say: "text", text: "닫기 완료", ts: 3 } as ClineMessage
		const grouped = groupMessages([close, result, laterText])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toEqual([close, result])
		expect(grouped[1]).toBe(laterText)
	})

	it("compacts repeated completed progress rows by category", () => {
		const grouped = groupLowStakesTools([
			{
				...createReasoningMessage(1, "파일/도구 처리 기록"),
				reasoning: "파일 A 확인",
				partial: false,
			},
			{
				...createReasoningMessage(2, "터미널 실행 기록"),
				reasoning: "dotnet build 실행",
				partial: false,
			},
			{
				...createReasoningMessage(3, "파일/도구 처리 기록"),
				reasoning: "파일 B 확인",
				partial: false,
			},
			{
				...createReasoningMessage(4, "터미널 실행 기록"),
				reasoning: "npm test 실행",
				partial: false,
			},
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "파일/도구 처리 기록" })
		expect((grouped[0] as ClineMessage).reasoning).toContain("파일 A 확인")
		expect((grouped[0] as ClineMessage).reasoning).toContain("파일 B 확인")
		expect(grouped[1]).toMatchObject({ type: "say", say: "reasoning", text: "터미널 실행 기록" })
		expect((grouped[1] as ClineMessage).reasoning).toContain("dotnet build 실행")
		expect((grouped[1] as ClineMessage).reasoning).toContain("npm test 실행")
	})

	it("strips raw SDK tool-call markup from folded progress rows", () => {
		const grouped = groupLowStakesTools([
			{
				...createReasoningMessage(1, "파일/도구 처리 기록"),
				reasoning:
					'파일 확인 중\n<function=run_commands> <parameter=commands> [{"command":"dir"}] </parameter> </function> </tool_call>\n다음 단계 준비',
				partial: false,
			},
		])

		expect(grouped).toHaveLength(1)
		expect((grouped[0] as ClineMessage).reasoning).toBe("파일 확인 중\n\n다음 단계 준비")
		expect((grouped[0] as ClineMessage).reasoning).not.toContain("<function=")
	})

	it("strips minimax-style raw tool-call markup from folded progress rows", () => {
		const grouped = groupLowStakesTools([
			{
				...createReasoningMessage(1, "응답 준비 기록"),
				reasoning:
					'대상 확인 중\n<function name="run_commands"> <parameter name="commands"> [{"command":"dir"}] </parameter> </function> </invoke> </minimax:tool_call>\n다음 단계 준비',
				partial: false,
			},
		])

		expect(grouped).toHaveLength(1)
		expect((grouped[0] as ClineMessage).reasoning).toBe("대상 확인 중\n\n다음 단계 준비")
		expect((grouped[0] as ClineMessage).reasoning).not.toContain("<function")
		expect((grouped[0] as ClineMessage).reasoning).not.toContain("tool_call")
	})

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
