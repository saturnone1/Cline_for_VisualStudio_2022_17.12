import { OnboardingModelGroup, type TerminalProfile } from "@shared/proto/cline/state"
import { useState } from "react"

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
