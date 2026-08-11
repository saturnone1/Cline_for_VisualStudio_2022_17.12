import { describe, expect, it } from "vitest"
import { validateWebviewRpcPayload } from "./WebviewRpcContract"

describe("Webview RPC payload compatibility", () => {
	it("accepts SDK PlanActMode enum values at the mode-toggle boundary", () => {
		expect(validateWebviewRpcPayload("StateService", "togglePlanActModeProto", "request", { mode: "PLAN" })).toEqual({
			ok: true,
		})
		expect(validateWebviewRpcPayload("StateService", "togglePlanActModeProto", "request", { mode: "ACT" })).toEqual({
			ok: true,
		})
	})

	it("still rejects non-string mode values", () => {
		expect(validateWebviewRpcPayload("StateService", "togglePlanActModeProto", "request", { mode: 1 })).toEqual({
			ok: false,
			reason: "invalid_field_type",
			field: "mode",
		})
	})
})
