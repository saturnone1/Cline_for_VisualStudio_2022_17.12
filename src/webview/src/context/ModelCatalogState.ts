import {
	basetenDefaultModelId,
	basetenModels,
	groqDefaultModelId,
	groqModels,
	type ModelInfo,
	openRouterDefaultModelId,
	openRouterDefaultModelInfo,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
} from "@shared/api"
import type { ExtensionState } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { OpenRouterCompatibleModelInfo } from "@shared/proto/cline/models"
import { fromProtobufModels } from "@shared/protoConversions/models/typeConversion"
import { useCallback, useEffect, useState } from "react"
import { ModelsServiceClient } from "../services/grpcClient"

export interface ModelCatalogState {
	clineModels: Record<string, ModelInfo> | null
	openRouterModels: Record<string, ModelInfo>
	vercelAiGatewayModels: Record<string, ModelInfo>
	hicapModels: Record<string, ModelInfo>
	liteLlmModels: Record<string, ModelInfo>
	openAiModels: string[]
	requestyModels: Record<string, ModelInfo>
	groqModels: Record<string, ModelInfo>
	basetenModels: Record<string, ModelInfo>
	huggingFaceModels: Record<string, ModelInfo>
	setRequestyModels: (value: Record<string, ModelInfo>) => void
	setGroqModels: (value: Record<string, ModelInfo>) => void
	setBasetenModels: (value: Record<string, ModelInfo>) => void
	setHuggingFaceModels: (value: Record<string, ModelInfo>) => void
	refreshClineModels: () => void
	refreshOpenRouterModels: () => void
	refreshVercelAiGatewayModels: () => void
	refreshHicapModels: () => void
	refreshLiteLlmModels: () => Promise<void>
}

type ApiConfiguration = ExtensionState["apiConfiguration"]

export function useModelCatalogState(apiConfiguration: ApiConfiguration): ModelCatalogState {
	const [clineModels, setClineModels] = useState<Record<string, ModelInfo> | null>(null)
	const [openRouterModels, setOpenRouterModels] = useState<Record<string, ModelInfo>>({
		[openRouterDefaultModelId]: openRouterDefaultModelInfo,
	})
	const [vercelAiGatewayModels, setVercelAiGatewayModels] = useState<Record<string, ModelInfo>>({})
	const [hicapModels, setHicapModels] = useState<Record<string, ModelInfo>>({})
	const [liteLlmModels, setLiteLlmModels] = useState<Record<string, ModelInfo>>({})
	const [openAiModels] = useState<string[]>([])
	const [requestyModels, setRequestyModels] = useState<Record<string, ModelInfo>>({
		[requestyDefaultModelId]: requestyDefaultModelInfo,
	})
	const [groqModelsState, setGroqModels] = useState<Record<string, ModelInfo>>({
		[groqDefaultModelId]: groqModels[groqDefaultModelId],
	})
	const [basetenModelsState, setBasetenModels] = useState<Record<string, ModelInfo>>({
		...basetenModels,
		[basetenDefaultModelId]: basetenModels[basetenDefaultModelId],
	})
	const [huggingFaceModels, setHuggingFaceModels] = useState<Record<string, ModelInfo>>({})

	const refreshOpenRouterModels = useCallback(() => {
		ModelsServiceClient.refreshOpenRouterModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => {
				setOpenRouterModels({
					[openRouterDefaultModelId]: openRouterDefaultModelInfo,
					...fromProtobufModels(response.models),
				})
			})
			.catch((error: Error) => console.error("Failed to refresh OpenRouter models:", error))
	}, [])

	const refreshHicapModels = useCallback(() => {
		ModelsServiceClient.refreshHicapModels(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => setHicapModels({ ...response.models }))
			.catch((error: Error) => console.error("Failed to refresh Hicap models:", error))
	}, [])

	const refreshLiteLlmModels = useCallback(() => {
		return ModelsServiceClient.refreshLiteLlmModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => setLiteLlmModels(fromProtobufModels(response.models)))
			.catch((error: Error) => console.error("Failed to refresh LiteLLM models:", error))
	}, [])

	const refreshBasetenModels = useCallback(() => {
		ModelsServiceClient.refreshBasetenModelsRpc(EmptyRequest.create({}))
			.then((response) => {
				setBasetenModels({
					[basetenDefaultModelId]: basetenModels[basetenDefaultModelId],
					...fromProtobufModels(response.models),
				})
			})
			.catch((error: Error) => console.error("Failed to refresh Baseten models:", error))
	}, [])

	const refreshVercelAiGatewayModels = useCallback(() => {
		ModelsServiceClient.refreshVercelAiGatewayModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => setVercelAiGatewayModels(fromProtobufModels(response.models)))
			.catch((error: Error) => console.error("Failed to refresh Vercel AI Gateway models:", error))
	}, [])

	const refreshClineModels = useCallback(() => {
		ModelsServiceClient.refreshClineModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => {
				const models = fromProtobufModels(response.models)
				setClineModels((previous) => (Object.keys(models).length > 0 ? models : (previous ?? null)))
			})
			.catch((error: Error) => console.error("Failed to refresh Cline models:", error))
	}, [])

	useEffect(() => {
		const activeProviders = new Set([apiConfiguration?.actModeApiProvider, apiConfiguration?.planModeApiProvider])
		if (activeProviders.has("openrouter") && Object.keys(openRouterModels).length <= 1) {
			refreshOpenRouterModels()
		}
		if (activeProviders.has("vercel-ai-gateway") && Object.keys(vercelAiGatewayModels).length === 0) {
			refreshVercelAiGatewayModels()
		}
		if (activeProviders.has("baseten") && apiConfiguration?.basetenApiKey) {
			refreshBasetenModels()
		}
		if (activeProviders.has("litellm") && apiConfiguration?.liteLlmApiKey) {
			refreshLiteLlmModels()
		}
	}, [
		apiConfiguration?.actModeApiProvider,
		apiConfiguration?.planModeApiProvider,
		apiConfiguration?.basetenApiKey,
		apiConfiguration?.liteLlmApiKey,
		openRouterModels,
		vercelAiGatewayModels,
		refreshOpenRouterModels,
		refreshVercelAiGatewayModels,
		refreshBasetenModels,
		refreshLiteLlmModels,
	])

	useEffect(() => {
		const hasClineProvider =
			apiConfiguration?.actModeApiProvider === "cline" || apiConfiguration?.planModeApiProvider === "cline"
		if (hasClineProvider && clineModels === null) {
			refreshClineModels()
		}
	}, [apiConfiguration?.actModeApiProvider, apiConfiguration?.planModeApiProvider, clineModels, refreshClineModels])

	return {
		clineModels,
		openRouterModels,
		vercelAiGatewayModels,
		hicapModels,
		liteLlmModels,
		openAiModels,
		requestyModels,
		groqModels: groqModelsState,
		basetenModels: basetenModelsState,
		huggingFaceModels,
		setRequestyModels,
		setGroqModels,
		setBasetenModels,
		setHuggingFaceModels,
		refreshClineModels,
		refreshOpenRouterModels,
		refreshVercelAiGatewayModels,
		refreshHicapModels,
		refreshLiteLlmModels,
	}
}
