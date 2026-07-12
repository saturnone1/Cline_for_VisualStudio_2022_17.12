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
	manifest = { $schema: "./webview-rpc.schema.json", schemaVersion: 1, protocolVersion: 1, operations: discovered }
	write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
} else {
	validateManifestShape(manifest)
	assertDiscoveryMatches(manifest.operations, discovered)
}

const outputs = generatedOutputs(manifest)
for (const [outputPath, content] of outputs) {
	if (check) {
		if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== content) fail(`Generated contract is stale: ${relative(outputPath)}`)
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
	if (value?.schemaVersion !== 1 || !Number.isInteger(value?.protocolVersion) || !Array.isArray(value?.operations)) fail("Invalid WebView RPC manifest header.")
	const keys = new Set()
	for (const operation of value.operations) {
		const key = `${operation.service}.${operation.method}`
		if (!/^[A-Za-z][A-Za-z0-9]*Service\.[A-Za-z][A-Za-z0-9]*$/.test(key)) fail(`Invalid RPC operation: ${key}`)
		if (keys.has(key)) fail(`Duplicate RPC operation: ${key}`)
		if (!["unary", "serverStream"].includes(operation.kind) || typeof operation.client !== "boolean" || typeof operation.sidecar !== "boolean") fail(`Invalid RPC operation metadata: ${key}`)
		if (operation.fallback !== undefined && operation.fallback !== "passive") fail(`Invalid fallback policy: ${key}`)
		keys.add(key)
	}
}

function assertDiscoveryMatches(expected, actual) {
	const normalize = (items) => JSON.stringify([...items].sort((a, b) => `${a.service}.${a.method}`.localeCompare(`${b.service}.${b.method}`)))
	if (normalize(expected) !== normalize(actual)) fail("contracts/webview-rpc.json does not match WebView clients, sidecar decoders, or C# fallback. Run the generator deliberately and review the contract diff.")
}

function generatedOutputs(value) {
	const operations = Object.fromEntries(value.operations.map((item) => [`${item.service}.${item.method}`, { kind: item.kind, client: item.client, sidecar: item.sidecar, ...(item.fallback ? { fallback: item.fallback } : {}) }]))
	const json = JSON.stringify(operations, null, "\t")
	const tsContent = `// <auto-generated by scripts/generate-webview-rpc-contracts.mjs>\nexport const WEBVIEW_RPC_PROTOCOL_VERSION = ${value.protocolVersion} as const\nexport const WEBVIEW_RPC_OPERATIONS = ${json} as const\nexport type WebviewRpcOperation = keyof typeof WEBVIEW_RPC_OPERATIONS\nexport function webviewRpcOperation(service: string, method: string) { return WEBVIEW_RPC_OPERATIONS[\`${"${service}.${method}"}\` as WebviewRpcOperation] }\n`
	const passive = value.operations.filter((item) => item.fallback === "passive").map((item) => `            "${item.service}.${item.method}"`).join(",\n")
	const csContent = `// <auto-generated by scripts/generate-webview-rpc-contracts.mjs>\nusing System;\nusing System.Collections.Generic;\nusing Newtonsoft.Json;\nusing Newtonsoft.Json.Linq;\n\nnamespace VsClineAgent.Host.Generated\n{\n    internal sealed class WebviewGrpcEnvelope\n    {\n        [JsonProperty("protocol_version")] public int? ProtocolVersion { get; set; }\n        [JsonProperty("protocolVersion")] private int? CamelProtocolVersion { set { if (!ProtocolVersion.HasValue) ProtocolVersion = value; } }\n        [JsonProperty("type")] public string Type { get; set; } = "";\n        [JsonProperty("grpc_request")] public WebviewGrpcRequest Request { get; set; }\n        [JsonProperty("grpc_request_cancel")] public WebviewGrpcCancellation Cancellation { get; set; }\n    }\n\n    internal sealed class WebviewGrpcRequest\n    {\n        [JsonProperty("service")] public string Service { get; set; } = "";\n        [JsonProperty("method")] public string Method { get; set; } = "";\n        [JsonProperty("request_id")] public string RequestId { get; set; } = "";\n        [JsonProperty("requestId")] private string CamelRequestId { set { if (string.IsNullOrWhiteSpace(RequestId)) RequestId = value; } }\n        [JsonProperty("is_streaming")] public bool IsStreaming { get; set; }\n        [JsonProperty("isStreaming")] private bool CamelIsStreaming { set { IsStreaming = IsStreaming || value; } }\n        [JsonProperty("message")] public JObject Message { get; set; } = new JObject();\n    }\n\n    internal sealed class WebviewGrpcCancellation\n    {\n        [JsonProperty("request_id")] public string RequestId { get; set; } = "";\n        [JsonProperty("requestId")] private string CamelRequestId { set { if (string.IsNullOrWhiteSpace(RequestId)) RequestId = value; } }\n    }\n\n    internal static class WebviewRpcContract\n    {\n        public const int ProtocolVersion = ${value.protocolVersion};\n        private static readonly HashSet<string> PassiveFallbackMethods = new HashSet<string>(StringComparer.Ordinal)\n        {\n${passive}\n        };\n\n        public static bool IsPassiveFallback(string service, string method)\n        {\n            return PassiveFallbackMethods.Contains(service + "." + method);\n        }\n    }\n}\n`
	const fixtures = value.operations.map((item, index) => ({ operation: `${item.service}.${item.method}`, envelope: { protocol_version: value.protocolVersion, type: "grpc_request", grpc_request: { service: item.service, method: item.method, request_id: `contract-${index + 1}`, is_streaming: item.kind === "serverStream", message: {} } } }))
	return [
		[path.join(repoRoot, "src/webview/src/services/generated/WebviewRpcContract.ts"), tsContent],
		[path.join(repoRoot, "src/sidecar/src/application/dto/generated/WebviewRpcContract.ts"), tsContent],
		[path.join(repoRoot, "src/extension/Host/Generated/WebviewRpcContract.cs"), csContent],
		[path.join(repoRoot, "contracts/generated/webview-rpc-fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`],
	]
}

function walk(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(root, entry.name)) : [path.join(root, entry.name)]) }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, "utf8") }
function relative(file) { return path.relative(repoRoot, file).replaceAll("\\", "/") }
function fail(message) { console.error(message); process.exit(1) }
