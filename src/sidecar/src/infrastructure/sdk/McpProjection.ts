export function isToolAutoApproved(serverConfig: Record<string, unknown>, toolName: string) {
	return stringArrayValue(asRecord(serverConfig.metadata).autoApproveTools).includes(toolName)
}

export async function callMcpListMethod(manager: unknown, serverName: string, methodNames: string[]) {
	const source = manager as Record<string, unknown>
	for (const methodName of methodNames) {
		const method = source[methodName]
		if (typeof method !== "function") continue
		try {
			const result = await method.call(manager, serverName)
			return Array.isArray(result) ? result : undefined
		} catch { return undefined }
	}
	return undefined
}

export function getArrayProperty(source: unknown, propertyName: string) {
	const value = asRecord(source)[propertyName]
	return Array.isArray(value) ? value : undefined
}

export function normalizeMcpResources(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value), uri = stringValue(record.uri)
		return uri ? [{ uri, name: stringValue(record.name) || uri, mimeType: stringValue(record.mimeType), description: stringValue(record.description) }] : []
	})
}

export function normalizeMcpResourceTemplates(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value), uriTemplate = stringValue(record.uriTemplate)
		return uriTemplate ? [{ uriTemplate, name: stringValue(record.name) || uriTemplate, description: stringValue(record.description), mimeType: stringValue(record.mimeType) }] : []
	})
}

export function normalizeMcpPrompts(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value), name = stringValue(record.name)
		return name ? [{ name, title: stringValue(record.title), description: stringValue(record.description), arguments: normalizeMcpPromptArguments(getArrayProperty(record, "arguments")) }] : []
	})
}

export function normalizeMcpPromptArguments(values: unknown[] | undefined): Array<Record<string, unknown>> {
	return (values || []).flatMap((value) => {
		const record = asRecord(value), name = stringValue(record.name)
		return name ? [{ name, description: stringValue(record.description), required: record.required === true }] : []
	})
}

export function toDisplayMcpConfig(registration: Record<string, unknown>, serverConfig: Record<string, unknown>) {
	const registrationTransport = asRecord(registration.transport)
	const transport = Object.keys(registrationTransport).length > 0 ? registrationTransport : asRecord(serverConfig.transport)
	const metadata = asRecord(registration.metadata)
	const timeout = numberValue(serverConfig.timeout) || numberValue(metadata.timeout)
	return { ...transport, ...(timeout ? { timeout } : {}), ...(serverConfig.disabled === true || registration.disabled === true ? { disabled: true } : {}) }
}

export function toProtoMcpStatus(status: string) {
	if (status === "connected") return "MCP_SERVER_STATUS_CONNECTED"
	if (status === "connecting") return "MCP_SERVER_STATUS_CONNECTING"
	return "MCP_SERVER_STATUS_DISCONNECTED"
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringValue(value: unknown) { return typeof value === "string" && value.trim().length > 0 ? value : undefined }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function stringArrayValue(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [] }
