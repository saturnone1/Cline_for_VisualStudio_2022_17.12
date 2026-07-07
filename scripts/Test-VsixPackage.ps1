param(
    [Parameter(Mandatory = $true)]
    [string]$VsixPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
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
        "VsClineAgent.dll",
        "WebApp/assets/index.css",
        "WebApp/assets/index.js",
        "WebApp/assets/lig-mark-black.png",
        "Sidecar/runtime/cline-sidecar.js",
        "Sidecar/runtime/node.exe",
        "Sidecar/runtime/sdk/ClineSdkRuntime.js",
        "Sidecar/runtime/webview/VisualStudioWebviewRouter.js"
    )

    foreach ($entryName in $requiredEntries) {
        if (-not $zip.GetEntry($entryName)) {
            Fail "Missing required entry: $entryName"
        }
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
