import { OnboardingModelGroup, type TerminalProfile } from "@shared/proto/cline/state"
import type React from "react"
import { createContext, createElement, useContext, useState } from "react"

export interface RuntimeViewState {
	showWelcome: boolean
	onboardingModels: OnboardingModelGroup | undefined
	totalTasksSize: number | null
	availableTerminalProfiles: TerminalProfile[]
	expandTaskHeader: boolean
	setShowWelcome: (value: boolean) => void
	setOnboardingModels: (value: OnboardingModelGroup | undefined) => void
	setTotalTasksSize: (value: number | null) => void
	setAvailableTerminalProfiles: (value: TerminalProfile[]) => void
	setExpandTaskHeader: (value: boolean) => void
}

export function useRuntimeViewState(): RuntimeViewState {
	const [showWelcome, setShowWelcome] = useState(false)
	const [onboardingModels, setOnboardingModels] = useState<OnboardingModelGroup>()
	const [totalTasksSize, setTotalTasksSize] = useState<number | null>(null)
	const [availableTerminalProfiles, setAvailableTerminalProfiles] = useState<TerminalProfile[]>([])
	const [expandTaskHeader, setExpandTaskHeader] = useState(true)

	return {
		showWelcome,
		onboardingModels,
		totalTasksSize,
		availableTerminalProfiles,
		expandTaskHeader,
		setShowWelcome,
		setOnboardingModels,
		setTotalTasksSize,
		setAvailableTerminalProfiles,
		setExpandTaskHeader,
	}
}

const RuntimeViewStateContext = createContext<RuntimeViewState | undefined>(undefined)

export function RuntimeViewStateProvider({ children }: { children: React.ReactNode }) {
	const value = useRuntimeViewState()
	return createElement(RuntimeViewStateContext.Provider, { value }, children)
}

export function useRuntimeViewStateContext(): RuntimeViewState {
	const context = useContext(RuntimeViewStateContext)
	if (!context) {
		throw new Error("useRuntimeViewStateContext must be used within RuntimeViewStateProvider")
	}
	return context
}
