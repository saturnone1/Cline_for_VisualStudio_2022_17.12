import { openRouterDefaultModelId, requestyDefaultModelId } from "@shared/api"
import type { ExtensionState } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, vi } from "vitest"
import { ModelsServiceClient } from "../services/grpcClient"
import { useModelCatalogState } from "./ModelCatalogState"

vi.mock("../services/grpcClient", () => {
	const pending = () => new Promise(() => undefined)
	return {
		ModelsServiceClient: {
			refreshOpenRouterModelsRpc: vi.fn(pending),
			refreshHicapModels: vi.fn(pending),
			refreshLiteLlmModelsRpc: vi.fn(pending),
			refreshBasetenModelsRpc: vi.fn(pending),
			refreshVercelAiGatewayModelsRpc: vi.fn(pending),
			refreshClineModelsRpc: vi.fn(pending),
		},
	}
})

describe("useModelCatalogState", () => {
	beforeEach(() => vi.clearAllMocks())

	it("provides stable default catalogs without eagerly loading inactive providers", () => {
		const { result } = renderHook(() => useModelCatalogState(undefined))

		expect(result.current.openRouterModels[openRouterDefaultModelId]).toBeDefined()
		expect(result.current.requestyModels[requestyDefaultModelId]).toBeDefined()
		expect(result.current.clineModels).toBeNull()
		expect(ModelsServiceClient.refreshOpenRouterModelsRpc).not.toHaveBeenCalled()
		expect(ModelsServiceClient.refreshClineModelsRpc).not.toHaveBeenCalled()
	})

	it("loads only the catalog selected by the active provider", () => {
		const apiConfiguration = { actModeApiProvider: "openrouter" } as ExtensionState["apiConfiguration"]
		renderHook(() => useModelCatalogState(apiConfiguration))

		expect(ModelsServiceClient.refreshOpenRouterModelsRpc).toHaveBeenCalledTimes(1)
		expect(ModelsServiceClient.refreshVercelAiGatewayModelsRpc).not.toHaveBeenCalled()
		expect(ModelsServiceClient.refreshClineModelsRpc).not.toHaveBeenCalled()
	})

	it("keeps externally supplied provider catalogs writable", () => {
		const { result } = renderHook(() => useModelCatalogState(undefined))

		act(() => result.current.setHuggingFaceModels({ custom: { contextWindow: 8192 } }))
		expect(result.current.huggingFaceModels.custom.contextWindow).toBe(8192)
	})
})
