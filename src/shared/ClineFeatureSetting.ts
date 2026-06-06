export interface ClineFeatureSetting {
	// Setting is enabled or disabled by user
	user: boolean
	// Setting is enabled or disabled by feature flag
	featureFlag: boolean
	// Optional explanation when the feature is unavailable.
	reason?: string
}
