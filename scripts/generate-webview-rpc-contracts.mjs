import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ts = require(path.join(repoRoot, "src/sidecar/node_modules/typescript"))
const manifestPath = path.join(repoRoot, "contracts/webview-rpc.json")
const clientPath = path.join(repoRoot, "src/webview/src/services/grpcClient.ts")
const sidecarWebviewRoot = path.join(repoRoot, "src/sidecar/src/infrastructure/webview")
const fallbackPath = path.join(repoRoot, "src/extension/Host/WebviewGrpcFallback.cs")
const bootstrap = process.argv.includes("--bootstrap")
const check = process.argv.includes("--check")

let manifest = bootstrap ? undefined : JSON.parse(fs.readFileSync(manifestPath, "utf8"))
const discovered = discoverOperations(new Set((manifest?.operations ?? []).filter((item) => item.fallback === "passive").map((item) => `${item.service}.${item.method}`)))
if (bootstrap) {
	manifest = { $schema: "./webview-rpc.schema.json", schemaVersion: 2, protocolVersion: 1, shapes: {}, operations: discovered }
	write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
} else {
	validateManifestShape(manifest)
	assertDiscoveryMatches(manifest.operations, discovered)
}

const outputs = generatedOutputs(manifest)
for (const [outputPath, content] of outputs) {
	if (check) {
		if (!fs.existsSync(outputPath) || normalizeLineEndings(fs.readFileSync(outputPath, "utf8")) !== normalizeLineEndings(content)) {
			fail(`Generated contract is stale: ${relative(outputPath)}`)
		}
	} else write(outputPath, content)
}
console.log(`WebView RPC contract ${check ? "check" : "generation"} passed (${manifest.operations.length} operations).`)

function discoverOperations(contractFallback) {
	const sourceText = fs.readFileSync(clientPath, "utf8")
	const source = ts.createSourceFile(clientPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	const interfaces = new Map()
	for (const statement of source.statements) {
		if (!ts.isInterfaceDeclaration(statement) || !statement.name.text.endsWith("ServiceContract")) continue
		interfaces.set(statement.name.text, statement)
	}
	const client = new Map()
	const exportPattern = /createServiceClient<([A-Za-z0-9]+ServiceContract)>\("([A-Za-z0-9]+Service)"\)/g
	for (const match of sourceText.matchAll(exportPattern)) {
		const declaration = interfaces.get(match[1])
		if (!declaration) fail(`Missing interface ${match[1]} for ${match[2]}`)
		for (const member of declaration.members) {
			if (!ts.isPropertySignature(member) || !member.name || !member.type) continue
			const method = member.name.getText(source).replace(/["']/g, "")
			const typeText = member.type.getText(source)
			client.set(`${match[2]}.${method}`, typeText.includes("StreamingOperation") ? "serverStream" : "unary")
		}
	}

	const server = new Set()
	const serverStreams = new Set()
	for (const file of walk(sidecarWebviewRoot).filter((item) => item.endsWith(".ts") && !item.includes(`${path.sep}generated${path.sep}`))) {
		const text = fs.readFileSync(file, "utf8")
		for (const match of text.matchAll(/["']([A-Za-z][A-Za-z0-9]*Service\.[A-Za-z][A-Za-z0-9]*)["']/g)) server.add(match[1])
		if (path.basename(file) === "StreamingRpcDecoder.ts") {
			for (const match of text.matchAll(/["']([A-Za-z][A-Za-z0-9]*Service\.[A-Za-z][A-Za-z0-9]*)["']/g)) serverStreams.add(match[1])
		}
	}
	const fallback = bootstrap
		? new Set([...fs.readFileSync(fallbackPath, "utf8").matchAll(/case\s+"([A-Za-z][A-Za-z0-9]*Service\.[A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]))
		: contractFallback
	const keys = [...new Set([...client.keys(), ...server])].sort()
	return keys.map((key) => {
		const separator = key.indexOf(".")
		const operation = {
			service: key.slice(0, separator), method: key.slice(separator + 1),
			kind: client.get(key) ?? (serverStreams.has(key) ? "serverStream" : "unary"),
			client: client.has(key), sidecar: server.has(key),
		}
		if (fallback.has(key)) operation.fallback = "passive"
		return operation
	})
}

function validateManifestShape(value) {
	if (value?.schemaVersion !== 2 || !Number.isInteger(value?.protocolVersion) || !isObject(value?.shapes) || !Array.isArray(value?.operations)) fail("Invalid WebView RPC manifest header.")
	for (const [shapeName, shape] of Object.entries(value.shapes)) {
		if (!/^[A-Za-z][A-Za-z0-9]*$/.test(shapeName) || !isObject(shape) || !isObject(shape.fields)) fail(`Invalid RPC payload shape: ${shapeName}`)
		for (const [fieldName, field] of Object.entries(shape.fields)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName) || !isObject(field) || !["string", "number", "boolean", "object", "array", "stringArray", "numberArray", "booleanArray", "objectArray", "unknown"].includes(field.type) || (field.required !== undefined && typeof field.required !== "boolean")) fail(`Invalid RPC payload field: ${shapeName}.${fieldName}`)
		}
		if (shape.allowAdditionalFields !== undefined && typeof shape.allowAdditionalFields !== "boolean") fail(`Invalid RPC payload additional-field policy: ${shapeName}`)
	}
	const keys = new Set()
	for (const operation of value.operations) {
		const key = `${operation.service}.${operation.method}`
		if (!/^[A-Za-z][A-Za-z0-9]*Service\.[A-Za-z][A-Za-z0-9]*$/.test(key)) fail(`Invalid RPC operation: ${key}`)
		if (keys.has(key)) fail(`Duplicate RPC operation: ${key}`)
		if (!["unary", "serverStream"].includes(operation.kind) || typeof operation.client !== "boolean" || typeof operation.sidecar !== "boolean") fail(`Invalid RPC operation metadata: ${key}`)
		if (operation.fallback !== undefined && operation.fallback !== "passive") fail(`Invalid fallback policy: ${key}`)
		const routes = ["settings", "account", "browser", "terminal", "task", "checkpoint", "hook", "scheduledAgent", "worktree", "mcp", "modelCatalog", "file", "instructionSettings", "uiWeb", "plugin", "stream"]
		if (operation.sidecar ? !routes.includes(operation.route) : operation.route !== undefined) fail(`Invalid sidecar route for ${key}: ${operation.route}`)
		if (operation.kind === "serverStream" && operation.sidecar && operation.route !== "stream") fail(`Streaming sidecar operation must use the stream route: ${key}`)
		for (const property of ["requestShape", "responseShape"]) {
			if (typeof operation[property] !== "string" || !value.shapes[operation[property]]) fail(`Missing or unknown ${property} for ${key}: ${operation[property]}`)
		}
		keys.add(key)
	}
}

function assertDiscoveryMatches(expected, actual) {
	const normalize = (items) => JSON.stringify(items.map(({ service, method, kind, client, sidecar, fallback }) => ({ service, method, kind, client, sidecar, ...(fallback ? { fallback } : {}) })).sort((a, b) => `${a.service}.${a.method}`.localeCompare(`${b.service}.${b.method}`)))
	if (normalize(expected) !== normalize(actual)) fail("contracts/webview-rpc.json does not match WebView clients, sidecar decoders, or C# fallback. Run the generator deliberately and review the contract diff.")
}

function generatedOutputs(value) {
	const operations = Object.fromEntries(value.operations.map((item) => [`${item.service}.${item.method}`, { kind: item.kind, client: item.client, sidecar: item.sidecar, ...(item.fallback ? { fallback: item.fallback } : {}), ...(item.route ? { route: item.route } : {}), requestShape: item.requestShape, responseShape: item.responseShape }]))
	const json = JSON.stringify(operations, null, "\t")
	const shapes = JSON.stringify(value.shapes, null, "\t")
	const sidecarRoutes = JSON.stringify([...new Set(value.operations.filter((item) => item.sidecar).map((item) => item.route))], null, "\t")
	const payloadTypes = Object.entries(value.shapes).map(([name, shape]) => `\t${JSON.stringify(name)}: {\n${Object.entries(shape.fields).map(([fieldName, rule]) => `\t\t${JSON.stringify(fieldName)}${rule.required ? "" : "?"}: ${typescriptPayloadType(rule.type)}`).join("\n")}${shape.allowAdditionalFields ? `${Object.keys(shape.fields).length ? "\n" : ""}\t\t[key: string]: unknown` : ""}\n\t}`).join("\n")
	const tsContent = `// <auto-generated by scripts/generate-webview-rpc-contracts.mjs>\nexport const WEBVIEW_RPC_PROTOCOL_VERSION = ${value.protocolVersion} as const\nexport const WEBVIEW_RPC_PAYLOAD_SHAPES = ${shapes} as const\nexport const WEBVIEW_RPC_OPERATIONS = ${json} as const\nexport const WEBVIEW_RPC_SIDECAR_ROUTES = ${sidecarRoutes} as const\nexport type WebviewRpcOperation = keyof typeof WEBVIEW_RPC_OPERATIONS\nexport type WebviewRpcSidecarRoute = (typeof WEBVIEW_RPC_SIDECAR_ROUTES)[number]\nexport type WebviewRpcPayloadShapeMap = {\n${payloadTypes}\n}\nexport type WebviewRpcRequestPayload<TOperation extends WebviewRpcOperation> = WebviewRpcPayloadShapeMap[(typeof WEBVIEW_RPC_OPERATIONS)[TOperation]["requestShape"]]\nexport type WebviewRpcResponsePayload<TOperation extends WebviewRpcOperation> = WebviewRpcPayloadShapeMap[(typeof WEBVIEW_RPC_OPERATIONS)[TOperation]["responseShape"]]\nexport function webviewRpcOperation(service: string, method: string) { return WEBVIEW_RPC_OPERATIONS[\`${"${service}.${method}"}\` as WebviewRpcOperation] }\nexport type WebviewRpcPayloadValidation = { ok: true } | { ok: false; reason: "payload_not_object" | "missing_required_field" | "invalid_field_type" | "unexpected_field"; field?: string }\nexport function validateWebviewRpcPayload(service: string, method: string, direction: "request" | "response", value: unknown): WebviewRpcPayloadValidation {\n\tconst operation = webviewRpcOperation(service, method)\n\tconst shapeName = operation && (direction === "request" ? "requestShape" in operation ? operation.requestShape : undefined : "responseShape" in operation ? operation.responseShape : undefined)\n\tif (!shapeName) return { ok: true }\n\tif (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "payload_not_object" }\n\tconst shape = WEBVIEW_RPC_PAYLOAD_SHAPES[shapeName]\n\tconst record = value as Record<string, unknown>\n\tfor (const [field, rule] of Object.entries(shape.fields) as Array<[string, { type: string; required?: boolean }]>) {\n\t\tif (record[field] === undefined) { if (rule.required) return { ok: false, reason: "missing_required_field", field }; continue }\n\t\tconst item = record[field]\n\t\tconst valid = rule.type === "unknown" || (rule.type === "string" && typeof item === "string") || (rule.type === "number" && typeof item === "number" && Number.isFinite(item)) || (rule.type === "boolean" && typeof item === "boolean") || (rule.type === "object" && typeof item === "object" && item !== null && !Array.isArray(item)) || (rule.type === "array" && Array.isArray(item)) || (rule.type === "stringArray" && Array.isArray(item) && item.every((entry) => typeof entry === "string")) || (rule.type === "numberArray" && Array.isArray(item) && item.every((entry) => typeof entry === "number" && Number.isFinite(entry))) || (rule.type === "booleanArray" && Array.isArray(item) && item.every((entry) => typeof entry === "boolean")) || (rule.type === "objectArray" && Array.isArray(item) && item.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry)))\n\t\tif (!valid) return { ok: false, reason: "invalid_field_type", field }\n\t}\n\tif (!("allowAdditionalFields" in shape && shape.allowAdditionalFields)) { for (const field of Object.keys(record)) if (!(field in shape.fields)) return { ok: false, reason: "unexpected_field", field } }\n\treturn { ok: true }\n}\n`
	const passive = value.operations.filter((item) => item.fallback === "passive").map((item) => `            "${item.service}.${item.method}"`).join(",\n")
	const csharpEntries = (items) => items.map((item) => `            "${item.service}.${item.method}"`).join(",\n")
	const knownOperations = csharpEntries(value.operations)
	const sidecarOperations = csharpEntries(value.operations.filter((item) => item.sidecar))
	const streamingOperations = csharpEntries(value.operations.filter((item) => item.kind === "serverStream"))
	const csContent = `// <auto-generated by scripts/generate-webview-rpc-contracts.mjs>\nusing System;\nusing System.Collections.Generic;\nusing Newtonsoft.Json;\nusing Newtonsoft.Json.Linq;\n\nnamespace VsClineAgent.Host.Generated\n{\n    internal sealed class WebviewGrpcEnvelope\n    {\n        [JsonProperty("protocol_version")] public int? ProtocolVersion { get; set; }\n        [JsonProperty("protocolVersion")] private int? CamelProtocolVersion { set { if (!ProtocolVersion.HasValue) ProtocolVersion = value; } }\n        [JsonProperty("type")] public string Type { get; set; } = "";\n        [JsonProperty("grpc_request")] public WebviewGrpcRequest Request { get; set; }\n        [JsonProperty("grpc_request_cancel")] public WebviewGrpcCancellation Cancellation { get; set; }\n    }\n\n    internal sealed class WebviewGrpcRequest\n    {\n        [JsonProperty("service")] public string Service { get; set; } = "";\n        [JsonProperty("method")] public string Method { get; set; } = "";\n        [JsonProperty("request_id")] public string RequestId { get; set; } = "";\n        [JsonProperty("requestId")] private string CamelRequestId { set { if (string.IsNullOrWhiteSpace(RequestId)) RequestId = value; } }\n        [JsonProperty("is_streaming")] public bool IsStreaming { get; set; }\n        [JsonProperty("isStreaming")] private bool CamelIsStreaming { set { IsStreaming = IsStreaming || value; } }\n        [JsonProperty("message")] public JObject Message { get; set; } = new JObject();\n    }\n\n    internal sealed class WebviewGrpcCancellation\n    {\n        [JsonProperty("request_id")] public string RequestId { get; set; } = "";\n        [JsonProperty("requestId")] private string CamelRequestId { set { if (string.IsNullOrWhiteSpace(RequestId)) RequestId = value; } }\n    }\n\n    internal static class WebviewRpcContract\n    {\n        public const int ProtocolVersion = ${value.protocolVersion};\n        private static readonly HashSet<string> KnownOperations = new HashSet<string>(StringComparer.Ordinal)\n        {\n${knownOperations}\n        };\n\n        private static readonly HashSet<string> SidecarOperations = new HashSet<string>(StringComparer.Ordinal)\n        {\n${sidecarOperations}\n        };\n\n        private static readonly HashSet<string> StreamingOperations = new HashSet<string>(StringComparer.Ordinal)\n        {\n${streamingOperations}\n        };\n\n        private static readonly HashSet<string> PassiveFallbackMethods = new HashSet<string>(StringComparer.Ordinal)\n        {\n${passive}\n        };\n\n        public static bool IsKnownOperation(string service, string method)\n        {\n            return KnownOperations.Contains(service + "." + method);\n        }\n\n        public static bool IsSidecarOperation(string service, string method)\n        {\n            return SidecarOperations.Contains(service + "." + method);\n        }\n\n        public static bool IsStreamingOperation(string service, string method)\n        {\n            return StreamingOperations.Contains(service + "." + method);\n        }\n\n        public static bool IsPassiveFallback(string service, string method)\n        {\n            return PassiveFallbackMethods.Contains(service + "." + method);\n        }\n    }\n}\n`
	const fixtures = value.operations.map((item, index) => ({ operation: `${item.service}.${item.method}`, request: fixtureForShape(value.shapes[item.requestShape]), response: fixtureForShape(value.shapes[item.responseShape]), envelope: { protocol_version: value.protocolVersion, type: "grpc_request", grpc_request: { service: item.service, method: item.method, request_id: `contract-${index + 1}`, is_streaming: item.kind === "serverStream", message: fixtureForShape(value.shapes[item.requestShape]) } } }))
	return [
		[path.join(repoRoot, "src/webview/src/services/generated/WebviewRpcContract.ts"), tsContent],
		[path.join(repoRoot, "src/sidecar/src/application/dto/generated/WebviewRpcContract.ts"), tsContent],
		[path.join(repoRoot, "src/extension/Host/Generated/WebviewRpcContract.cs"), csContent],
		[path.join(repoRoot, "contracts/generated/webview-rpc-fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`],
	]
}

function fixtureForShape(shape) {
	if (!shape) return {}
	return Object.fromEntries(Object.entries(shape.fields).filter(([, rule]) => rule.required).map(([field, rule]) => [field, rule.type === "string" ? "fixture" : rule.type === "number" ? 0 : rule.type === "boolean" ? false : rule.type.endsWith("Array") || rule.type === "array" ? [] : {}]))
}

function typescriptPayloadType(type) {
	return ({ string: "string", number: "number", boolean: "boolean", object: "Record<string, unknown>", array: "unknown[]", stringArray: "string[]", numberArray: "number[]", booleanArray: "boolean[]", objectArray: "Array<Record<string, unknown>>", unknown: "unknown" })[type]
}

function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value) }
function normalizeLineEndings(value) { return value.replace(/\r\n/g, "\n") }

function walk(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(root, entry.name)) : [path.join(root, entry.name)]) }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, "utf8") }
function relative(file) { return path.relative(repoRoot, file).replaceAll("\\", "/") }
function fail(message) { console.error(message); process.exit(1) }
