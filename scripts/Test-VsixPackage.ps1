param(
    [Parameter(Mandatory = $true)]
    [string]$VsixPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,

    [string]$ExpectedAssembly = "VsClineAgent.dll"
)

$ErrorActionPreference = "Stop"

function Fail($Message) {
    throw "[VSIX validation failed] $Message"
}

$resolvedVsix = Resolve-Path -LiteralPath $VsixPath
$vsixItem = Get-Item -LiteralPath $resolvedVsix

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($resolvedVsix.Path)

try {
    $requiredEntries = @(
        "extension.vsixmanifest",
        "manifest.json",
        "catalog.json",
        $ExpectedAssembly,
        "Newtonsoft.Json.dll",
        "WebApp/assets/index.css",
        "WebApp/assets/index.js",
        "WebApp/assets/lig-mark-black.png",
        "Sidecar/runtime/cline-sidecar.js",
        "Sidecar/runtime/node.exe",
        "Sidecar/runtime/application/ports/AgentEnginePort.js",
        "Sidecar/runtime/application/useCases/McpUseCase.js",
        "Sidecar/runtime/application/useCases/StatePersistenceUseCase.js",
        "Sidecar/runtime/application/useCases/TaskLifecycleUseCase.js",
        "Sidecar/runtime/application/useCases/TaskSessionUseCase.js",
        "Sidecar/runtime/application/services/CommandPolicy.js",
        "Sidecar/runtime/application/services/PatchPolicy.js",
		"Sidecar/runtime/application/services/ProviderIdentity.js",
        "Sidecar/runtime/domain/task/TaskLifecycle.js",
        "Sidecar/runtime/infrastructure/persistence/JsonStateStore.js",
		"Sidecar/runtime/infrastructure/persistence/LocalAutomationStore.js",
		"Sidecar/runtime/infrastructure/auth/ProviderAuthSupport.js",
        "Sidecar/runtime/infrastructure/browser/BrowserDevToolsAdapter.js",
		"Sidecar/runtime/infrastructure/configuration/ProviderConfiguration.js",
		"Sidecar/runtime/infrastructure/conversation/ConversationSupport.js",
		"Sidecar/runtime/infrastructure/hooks/HookRuntime.js",
		"Sidecar/runtime/infrastructure/models/ModelCatalog.js",
        "Sidecar/runtime/infrastructure/sdk/ClineSdkRuntime.js",
        "Sidecar/runtime/infrastructure/transport/JsonRpcConnection.js",
        "Sidecar/runtime/infrastructure/transport/SidecarRpcServer.js",
        "Sidecar/runtime/infrastructure/webview/VisualStudioWebviewBackend.js",
		"Sidecar/runtime/infrastructure/webview/WebviewState.js",
		"Sidecar/runtime/infrastructure/worktree/WorktreeSupport.js",
        "Sidecar/runtime/presentation/webview/VisualStudioWebviewController.js"
    )

    foreach ($entryName in $requiredEntries) {
        if (-not $zip.GetEntry($entryName)) {
            Fail "Missing required entry: $entryName"
        }
    }

    $nodeEntries = @($zip.Entries | Where-Object { $_.FullName -like "*node.exe" })
    if ($nodeEntries.Count -gt 2) {
        Fail "Unexpected duplicate node.exe payloads: $($nodeEntries.Count)"
    }

    $nestedWebView2Entries = @($zip.Entries | Where-Object { $_.FullName -like "Sidecar/runtime/Microsoft.WebView2*" })
    if ($nestedWebView2Entries.Count -gt 0) {
        Fail "WebView2 runtime was duplicated under Sidecar/runtime."
    }

    if ($vsixItem.Length -gt 700MB) {
        Fail "VSIX is unexpectedly large: $($vsixItem.Length) bytes"
    }

    $extensionEntry = $zip.GetEntry("extension.vsixmanifest")
    $reader = [System.IO.StreamReader]::new($extensionEntry.Open())
    $extensionText = $reader.ReadToEnd()
    $reader.Dispose()
    [xml]$extensionManifest = $extensionText
    $extensionVersion = [string]$extensionManifest.PackageManifest.Metadata.Identity.Version

    $manifestEntry = $zip.GetEntry("manifest.json")
    $reader = [System.IO.StreamReader]::new($manifestEntry.Open())
    $manifestText = $reader.ReadToEnd()
    $reader.Dispose()
    $manifest = $manifestText | ConvertFrom-Json
    $manifestVersion = [string]$manifest.version

    $catalogEntry = $zip.GetEntry("catalog.json")
    $reader = [System.IO.StreamReader]::new($catalogEntry.Open())
    $catalogText = $reader.ReadToEnd()
    $reader.Dispose()
    $catalog = $catalogText | ConvertFrom-Json

    $catalogVersions = @($catalog.packages | ForEach-Object { [string]$_.version })
    $catalogInfoId = [string]$catalog.info.id
    $catalogDependencyVersion = [string]$catalog.packages[0].dependencies.PSObject.Properties[$manifest.id].Value
    $catalogPayloadSize = [int64]$catalog.packages[1].payloads[0].size

    $versions = @($extensionVersion, $manifestVersion) + $catalogVersions + @($catalogDependencyVersion)
    foreach ($version in $versions) {
        if ($version -ne $ExpectedVersion) {
            Fail "Version mismatch. Expected $ExpectedVersion but found $version."
        }
    }

    if ($catalogInfoId -notmatch [regex]::Escape("version=$ExpectedVersion")) {
        Fail "catalog.json info.id does not contain version=$ExpectedVersion."
    }

    foreach ($name in @("extension.vsixmanifest", "manifest.json", "catalog.json")) {
        $entry = $zip.GetEntry($name)
        $reader = [System.IO.StreamReader]::new($entry.Open())
        $text = $reader.ReadToEnd()
        $reader.Dispose()
        if ($text -match "version=1\.2" -or $text -match '"version"\s*:\s*"1\.2"' -or $text -match 'Version="1\.2"') {
            Fail "Found stale 1.2 version marker in $name."
        }
    }

    if ($catalogPayloadSize -ne $vsixItem.Length) {
        Write-Warning "catalog.json payload size ($catalogPayloadSize) does not match VSIX size ($($vsixItem.Length))."
    }

    Write-Host "VSIX validation passed: $($resolvedVsix.Path)"
    Write-Host "Version: $ExpectedVersion"
    Write-Host "Size: $($vsixItem.Length)"
}
finally {
    $zip.Dispose()
}
