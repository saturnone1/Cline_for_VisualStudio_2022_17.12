import { normalizeApiConfiguration, normalizeApiConfigurationProfiles } from "./ProviderConfiguration"

type Profile = Record<string, unknown>
type Callbacks = Readonly<{
	readConfiguration: () => Profile
	writeConfiguration: (configuration: Profile) => void
	readProfiles: () => unknown
	writeProfiles: (profiles: Profile[]) => void
	readActiveId: () => string
	writeActiveId: (profileId: string) => void
	readSeparateModels: () => boolean
	writeSeparateModels: (enabled: boolean) => void
}>

export class ApiConfigurationProfileManager {
	constructor(private readonly callbacks: Callbacks) {}

	ensure() {
		const profiles = normalizeApiConfigurationProfiles(this.callbacks.readProfiles(), this.callbacks.readConfiguration(), this.callbacks.readSeparateModels())
		this.callbacks.writeProfiles(profiles)
		const activeId = this.callbacks.readActiveId()
		if (!profiles.some((profile) => readString(profile.id) === activeId)) this.callbacks.writeActiveId(readString(profiles[0]?.id))
	}

	activate(profileId: string) {
		this.ensure()
		const profiles = records(this.callbacks.readProfiles())
		const profile = profiles.find((candidate) => readString(candidate.id) === profileId) || profiles[0]
		if (!profile) return
		this.callbacks.writeActiveId(readString(profile.id))
		this.apply(profile)
	}

	syncActive() {
		this.ensure()
		const activeId = this.callbacks.readActiveId()
		const configuration = normalizeApiConfiguration(this.callbacks.readConfiguration())
		const separateModels = this.callbacks.readSeparateModels()
		const updatedAt = new Date().toISOString()
		this.callbacks.writeProfiles(records(this.callbacks.readProfiles()).map((profile) => readString(profile.id) === activeId
			? { ...profile, apiConfiguration: configuration, planActSeparateModelsSetting: separateModels, updatedAt }
			: profile))
	}

	private apply(profile: Profile) {
		this.callbacks.writeConfiguration(normalizeApiConfiguration(asRecord(profile.apiConfiguration)))
		if (typeof profile.planActSeparateModelsSetting === "boolean") this.callbacks.writeSeparateModels(profile.planActSeparateModelsSetting)
	}
}

function records(value: unknown): Profile[] { return Array.isArray(value) ? value.map(asRecord) : [] }
function asRecord(value: unknown): Profile { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Profile : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
