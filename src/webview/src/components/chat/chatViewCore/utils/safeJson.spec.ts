import { describe, expect, it } from "vitest"
import { parseJsonObject } from "./safeJson"

describe("parseJsonObject", () => {
	it("contains malformed and non-object transcript payloads", () => {
		expect(parseJsonObject("{partial")).toEqual({})
		expect(parseJsonObject("[]")).toEqual({})
		expect(parseJsonObject("null")).toEqual({})
	})

	it("preserves a valid structured transcript payload", () => {
		expect(parseJsonObject<{ tool: string }>('{"tool":"readFile"}')).toEqual({ tool: "readFile" })
	})
})
