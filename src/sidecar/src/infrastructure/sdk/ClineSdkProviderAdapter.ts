type ClineSdkModule = typeof import("@cline/sdk")

export class ClineSdkProviderAdapter {
	async getConfigFields(providerId: string): Promise<unknown> {
		const sdk = await importClineSdk()
		const getFields = sdk.getProviderConfigFields as ((providerId: string) => unknown) | undefined
		return typeof getFields === "function" ? getFields(providerId) : null
	}
}

async function importClineSdk(): Promise<ClineSdkModule> {
	const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ClineSdkModule>
	return importEsm("@cline/sdk")
}
