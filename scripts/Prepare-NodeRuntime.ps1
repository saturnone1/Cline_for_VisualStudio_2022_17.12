param(
    [string]$Version = "22.23.1",

    [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $repoRoot "artifacts\Sidecar"
$runtimePath = Join-Path $runtimeDirectory "node.exe"
$archiveName = "node-v$Version-win-x64.zip"
$expectedHashes = @{
    "22.23.1" = "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29"
}

if (-not $expectedHashes.ContainsKey($Version)) {
    throw "Node.js $Version is not pinned. Add its official archive SHA-256 before using it."
}

if (Test-Path -LiteralPath $runtimePath) {
    $installedVersion = (& $runtimePath --version).TrimStart("v")
    if ($LASTEXITCODE -eq 0 -and $installedVersion -eq $Version) {
        Write-Host "Bundled Node.js runtime is ready: $runtimePath (v$installedVersion)"
        return
    }

    throw "Unexpected bundled Node.js runtime at $runtimePath (expected v$Version, found v$installedVersion). Remove it and run this script again."
}

if (-not $ArchivePath) {
    $downloadDirectory = Join-Path $repoRoot "downloads"
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    $ArchivePath = Join-Path $downloadDirectory $archiveName

    if (-not (Test-Path -LiteralPath $ArchivePath)) {
        $downloadUri = "https://nodejs.org/dist/v$Version/$archiveName"
        Write-Host "Downloading pinned Node.js runtime from $downloadUri"
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUri -OutFile $ArchivePath
    }
}

$ArchivePath = (Resolve-Path -LiteralPath $ArchivePath).Path
$actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedHash = $expectedHashes[$Version]
if ($actualHash -ne $expectedHash) {
    throw "Node.js archive SHA-256 mismatch. Expected $expectedHash, found $actualHash."
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("VsClineAgent-Node-" + [Guid]::NewGuid().ToString("N"))
try {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $temporaryDirectory
    $extractedRuntime = Join-Path $temporaryDirectory "node-v$Version-win-x64\node.exe"
    if (-not (Test-Path -LiteralPath $extractedRuntime)) {
        throw "The Node.js archive does not contain the expected node.exe."
    }

    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    Copy-Item -LiteralPath $extractedRuntime -Destination $runtimePath
}
finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $resolvedTemporaryDirectory = [System.IO.Path]::GetFullPath($temporaryDirectory)
        if (-not $resolvedTemporaryDirectory.StartsWith($resolvedTemporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([System.IO.Path]::GetFileName($resolvedTemporaryDirectory)).StartsWith("VsClineAgent-Node-", [StringComparison]::Ordinal)) {
            throw "Refusing to remove unexpected temporary directory: $resolvedTemporaryDirectory"
        }
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}

$preparedVersion = (& $runtimePath --version).TrimStart("v")
if ($LASTEXITCODE -ne 0 -or $preparedVersion -ne $Version) {
    throw "Prepared Node.js runtime failed version validation."
}

Write-Host "Bundled Node.js runtime prepared: $runtimePath (v$preparedVersion)"
