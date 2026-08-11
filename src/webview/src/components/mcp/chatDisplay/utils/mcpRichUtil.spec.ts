import { beforeEach, describe, expect, it, vi } from "vitest"
import { WebServiceClient } from "@/services/grpcClient"
import { checkIfImageUrl, extractUrlsFromText, processUrlTypes } from "./mcpRichUtil"

vi.mock("@/services/grpcClient", () => ({
	WebServiceClient: {
		checkIsImageUrl: vi.fn(),
	},
}))

const checkIsImageUrl = vi.mocked(WebServiceClient.checkIsImageUrl)

describe("MCP rich URL processing", () => {
	beforeEach(() => checkIsImageUrl.mockReset())

	it("delegates both HTTP and HTTPS image checks to the host transport", async () => {
		checkIsImageUrl.mockResolvedValue({ isImage: true })
		await expect(checkIfImageUrl("http://example.com/a.png")).resolves.toBe(true)
		await expect(checkIfImageUrl("https://example.com/b.png")).resolves.toBe(true)
		expect(checkIsImageUrl).toHaveBeenCalledTimes(2)
	})

	it("keeps URL extraction bounded without returning local addresses", () => {
		const matches = extractUrlsFromText(
			"https://example.com/a https://localhost/private https://example.com/b https://example.com/c",
			2,
		)
		expect(matches.map((match) => match.url)).toEqual(["https://example.com/a", "https://example.com/b"])
	})

	it("checks URLs in bounded batches and emits one update per batch", async () => {
		let active = 0
		let peak = 0
		checkIsImageUrl.mockImplementation(async () => {
			active++
			peak = Math.max(peak, active)
			await Promise.resolve()
			active--
			return { isImage: true }
		})
		const matches = Array.from({ length: 5 }, (_, index) => ({
			url: `https://example.com/${index}.png`,
			fullMatch: `https://example.com/${index}.png`,
			index,
			isImage: false,
			isProcessed: false,
		}))
		const onProgress = vi.fn()
		await processUrlTypes(matches, onProgress, { cancelled: false })
		expect(peak).toBeGreaterThan(1)
		expect(peak).toBeLessThan(matches.length)
		expect(onProgress.mock.calls.length).toBeLessThan(matches.length)
		expect(matches.every((match) => match.isProcessed && match.isImage)).toBe(true)
	})
})
