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

function Assert-EmbeddedMenu($Zip, [string]$AssemblyEntryName) {
	$assemblyEntry = $Zip.GetEntry($AssemblyEntryName)
	$memory = [System.IO.MemoryStream]::new()
	$assemblyStream = $assemblyEntry.Open()
	try { $assemblyStream.CopyTo($memory) }
	finally { $assemblyStream.Dispose() }

	$assembly = [System.Reflection.Assembly]::Load($memory.ToArray())
	foreach ($resourceName in $assembly.GetManifestResourceNames()) {
		if (-not $resourceName.EndsWith(".resources", [StringComparison]::OrdinalIgnoreCase)) { continue }
		$resourceStream = $assembly.GetManifestResourceStream($resourceName)
		$reader = [System.Resources.ResourceReader]::new($resourceStream)
		try {
			$entries = $reader.GetEnumerator()
			while ($entries.MoveNext()) {
				if ([string]$entries.Key -eq "Menus.ctmenu" -and $entries.Value -is [byte[]] -and $entries.Value.Length -ge 32) {
					return
				}
			}
		}
		finally { $reader.Dispose(); $resourceStream.Dispose() }
	}
	Fail "$AssemblyEntryName does not contain a valid embedded Menus.ctmenu resource."
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
        "VsClineAgent.pkgdef",
        $ExpectedAssembly,
        "Newtonsoft.Json.dll",
        "WebApp/assets/index.css",
        "WebApp/assets/index.js",
        "WebApp/assets/lig-mark-black.png",
        "Sidecar/runtime/cline-sidecar.js",
        "Sidecar/runtime/node.exe",
        "Sidecar/node_modules.fingerprint",
		"Sidecar/runtime/bootstrap/SidecarConnectionFactory.js",
		"Sidecar/runtime/application/dto/WebviewRpc.js",
        "Sidecar/runtime/application/ports/AgentEnginePort.js",
		"Sidecar/runtime/features/mcp/McpHandler.js",
        "Sidecar/runtime/application/useCases/StatePersistenceUseCase.js",
        "Sidecar/runtime/application/useCases/TaskLifecycleUseCase.js",
        "Sidecar/runtime/application/useCases/TaskSessionUseCase.js",
        "Sidecar/runtime/application/services/CommandPolicy.js",
        "Sidecar/runtime/application/services/PatchPolicy.js",
		"Sidecar/runtime/application/services/ProviderIdentity.js",
        "Sidecar/runtime/domain/task/TaskLifecycle.js",
		"Sidecar/runtime/domain/agent/AgentRuntimeEvent.js",
		"Sidecar/runtime/domain/agent/AgentSessionState.js",
		"Sidecar/runtime/features/chat/sendMessage/SendMessageCommand.js",
		"Sidecar/runtime/features/chat/sendMessage/SendMessageHandler.js",
		"Sidecar/runtime/features/chat/startTask/StartTaskCommand.js",
		"Sidecar/runtime/features/chat/startTask/StartTaskHandler.js",
		"Sidecar/runtime/features/chat/cancelTask/CancelTaskCommand.js",
		"Sidecar/runtime/features/chat/cancelTask/CancelTaskHandler.js",
		"Sidecar/runtime/features/approvals/ApprovalCoordinator.js",
		"Sidecar/runtime/features/taskHistory/TaskHistoryCollection.js",
		"Sidecar/runtime/features/providers/ProviderSelection.js",
		"Sidecar/runtime/features/settings/PlanActMode.js",
		"Sidecar/runtime/features/worktrees/WorktreePolicy.js",
		"Sidecar/runtime/features/browser/BrowserPolicy.js",
		"Sidecar/runtime/features/hooks/HookPolicy.js",
		"Sidecar/runtime/features/scheduledAgents/ScheduledAgentPolicy.js",
		"Sidecar/runtime/features/checkpoints/CheckpointPolicy.js",
        "Sidecar/runtime/infrastructure/persistence/JsonStateStore.js",
		"Sidecar/runtime/infrastructure/persistence/LocalAutomationStore.js",
		"Sidecar/runtime/infrastructure/auth/ProviderAuthSupport.js",
        "Sidecar/runtime/infrastructure/browser/BrowserDevToolsAdapter.js",
		"Sidecar/runtime/infrastructure/configuration/ProviderConfiguration.js",
		"Sidecar/runtime/infrastructure/conversation/ConversationSupport.js",
		"Sidecar/runtime/infrastructure/hooks/HookRuntime.js",
		"Sidecar/runtime/infrastructure/models/ModelCatalog.js",
        "Sidecar/runtime/infrastructure/sdk/ClineSdkRuntime.js",
		"Sidecar/runtime/infrastructure/sdk/ClineSdkEventTranslator.js",
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

	Assert-EmbeddedMenu $zip $ExpectedAssembly

    $pkgDefEntry = $zip.GetEntry("VsClineAgent.pkgdef")
    $reader = [System.IO.StreamReader]::new($pkgDefEntry.Open())
    $pkgDefText = $reader.ReadToEnd()
    $reader.Dispose()
    if ($pkgDefText -notmatch [regex]::Escape('"CodeBase"="$PackageFolder$\' + $ExpectedAssembly + '"')) {
        Fail "VsClineAgent.pkgdef does not register the expected assembly CodeBase: $ExpectedAssembly"
    }

    $nodeEntries = @($zip.Entries | Where-Object { $_.FullName -like "*node.exe" })
    if ($nodeEntries.Count -ne 1 -or $nodeEntries[0].FullName -ne "Sidecar/runtime/node.exe") {
        Fail "VSIX must contain exactly one bundled Node runtime under Sidecar/runtime. Found: $($nodeEntries.FullName -join ', ')"
    }

    $duplicateSidecarRoots = @($zip.Entries | Where-Object {
        $_.FullName -eq "Sidecar/cline-sidecar.js" -or
        $_.FullName -like "Sidecar/application/*" -or
        $_.FullName -like "Sidecar/bootstrap/*" -or
        $_.FullName -like "Sidecar/domain/*" -or
        $_.FullName -like "Sidecar/features/*" -or
        $_.FullName -like "Sidecar/infrastructure/*" -or
        $_.FullName -like "Sidecar/presentation/*"
    })
    if ($duplicateSidecarRoots.Count -gt 0) {
        Fail "Sidecar runtime files were duplicated outside Sidecar/runtime: $($duplicateSidecarRoots[0].FullName)"
    }

    $nestedWebView2Entries = @($zip.Entries | Where-Object { $_.FullName -like "Sidecar/runtime/Microsoft.WebView2*" })
    if ($nestedWebView2Entries.Count -gt 0) {
        Fail "WebView2 runtime was duplicated under Sidecar/runtime."
    }

    $fixedRuntimeExecutables = @($zip.Entries | Where-Object {
        $_.FullName -like "WebView2Runtime/Microsoft.WebView2.FixedVersionRuntime.*.x64/msedgewebview2.exe"
    })
    if ($fixedRuntimeExecutables.Count -ne 1 -or $fixedRuntimeExecutables[0].Length -le 0) {
        Fail "VSIX must contain one usable x64 WebView2 Fixed Version Runtime."
    }

    if ($vsixItem.Length -gt 550MB) {
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

	if ($catalogPayloadSize -le 0) {
		Fail "catalog.json contains an invalid payload size: $catalogPayloadSize"
	}
	$catalogSizeDelta = [Math]::Abs($catalogPayloadSize - $vsixItem.Length)
	if ($catalogSizeDelta -gt 1MB) {
		Fail "catalog.json payload size differs from the final VSIX by $catalogSizeDelta bytes."
	}
	if ($catalogSizeDelta -gt 0) {
		Write-Host "Catalog payload size is within packaging tolerance (delta: $catalogSizeDelta bytes)."
	}

    Write-Host "VSIX validation passed: $($resolvedVsix.Path)"
    Write-Host "Version: $ExpectedVersion"
    Write-Host "Size: $($vsixItem.Length)"
}
finally {
    $zip.Dispose()
}
