param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",

    [string]$MSBuildPath,

    [string]$NodeRuntimeArchive,

    [switch]$SkipFrontend,

    [switch]$SkipSidecar,

    [switch]$SkipWebview
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent

& (Join-Path $PSScriptRoot "Sync-ProductVersion.ps1")
[xml]$productVersionProps = Get-Content -LiteralPath (Join-Path $repoRoot "packaging\ProductVersion.props")
$expectedProductVersion = [string]$productVersionProps.Project.PropertyGroup.ProductVersion

& (Join-Path $PSScriptRoot "Test-MenuContract.ps1") -RepoRoot $repoRoot
& node (Join-Path $PSScriptRoot "generate-webview-rpc-contracts.mjs") --check
if ($LASTEXITCODE -ne 0) { throw "WebView RPC contract check failed with exit code $LASTEXITCODE" }

if (-not $MSBuildPath) {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere) {
        $MSBuildPath = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
    }
}

if (-not $MSBuildPath -and (Test-Path -LiteralPath "C:\BuildTools2022\MSBuild\Current\Bin\MSBuild.exe")) {
    $MSBuildPath = "C:\BuildTools2022\MSBuild\Current\Bin\MSBuild.exe"
}

if (-not $MSBuildPath -or -not (Test-Path -LiteralPath $MSBuildPath)) {
    throw "Visual Studio MSBuild was not found. Pass -MSBuildPath explicitly."
}

$installationRoot = Split-Path (Split-Path (Split-Path (Split-Path $MSBuildPath -Parent) -Parent) -Parent) -Parent
$vsToolsPath = Join-Path $installationRoot "MSBuild\Microsoft\VisualStudio\v17.0"
if (-not (Test-Path -LiteralPath $vsToolsPath)) {
	$vsToolsPath = $null
	Write-Host "Visual Studio 2022 VSSDK path is not installed; using the project's VSSDK BuildTools package."
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Assert-GeneratedArtifactFresh([string]$Name, [string]$SourceDirectory, [string]$ArtifactPath) {
    if (-not (Test-Path -LiteralPath $ArtifactPath)) {
        throw "$Name artifact is missing: $ArtifactPath"
    }
    $latestSource = Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File |
        Where-Object { $_.Extension -in @(".ts", ".tsx", ".js", ".mjs", ".css", ".html", ".json") } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    $artifact = Get-Item -LiteralPath $ArtifactPath
    if ($latestSource -and $latestSource.LastWriteTimeUtc -gt $artifact.LastWriteTimeUtc) {
        throw "$Name artifact is stale. Rebuild it or remove the matching skip option. Latest source: $($latestSource.FullName)"
    }
}

$prepareNodeArguments = @{}
if ($NodeRuntimeArchive) {
    $prepareNodeArguments.ArchivePath = $NodeRuntimeArchive
}
& (Join-Path $PSScriptRoot "Prepare-NodeRuntime.ps1") @prepareNodeArguments

if (-not $SkipFrontend) {
    foreach ($frontendDirectory in @("src\sidecar", "src\webview")) {
        $absoluteFrontendDirectory = Join-Path $repoRoot $frontendDirectory
        if (-not (Test-Path -LiteralPath (Join-Path $absoluteFrontendDirectory "node_modules"))) {
            Invoke-Checked "npm.cmd" @("ci") $absoluteFrontendDirectory
        }
    }
}

$skipSidecarBuild = $SkipFrontend -or $SkipSidecar
$skipWebviewBuild = $SkipFrontend -or $SkipWebview
if ($skipSidecarBuild) {
    Assert-GeneratedArtifactFresh "Sidecar" (Join-Path $repoRoot "src\sidecar\src") (Join-Path $repoRoot "artifacts\Sidecar\cline-sidecar.js")
} else {
    Invoke-Checked "npm.cmd" @("run", "build") (Join-Path $repoRoot "src\sidecar")
}
if ($skipWebviewBuild) {
    Invoke-Checked "node" @("scripts/webAppSnapshot.mjs", "--check") (Join-Path $repoRoot "src\webview")
} else {
    Invoke-Checked "npm.cmd" @("run", "build") (Join-Path $repoRoot "src\webview")
}

$variants = @(
    @{ Target = "17.0"; Assembly = "VsClineAgent17.dll"; Vsix = "VsClineAgent17.vsix"; Manifest = "packaging\vs2022-17.0\source.extension.vsixmanifest" },
    @{ Target = "17.12"; Assembly = "VsClineAgent.dll"; Vsix = "VsClineAgent.vsix"; Manifest = "packaging\vs2022-17.12\source.extension.vsixmanifest" }
)
$builtVariants = @{}

foreach ($variant in $variants) {
    $msbuildArguments = @(
        (Join-Path $repoRoot "VsClineAgent.sln"),
        "/restore",
        "/t:Rebuild",
        "/p:VsTarget=$($variant.Target)",
        "/p:Configuration=$Configuration",
        "/p:DeployExtension=false",
		"/warnaserror",
        "/v:minimal"
    )
	if ($vsToolsPath) {
		$msbuildArguments += "/p:VSToolsPath=$vsToolsPath"
	}
    Invoke-Checked $MSBuildPath $msbuildArguments $repoRoot

    $vsixPath = Join-Path $repoRoot "src\extension\bin\$($variant.Target)\$Configuration\$($variant.Vsix)"
	    & (Join-Path $PSScriptRoot "Test-VsixPackage.ps1") -VsixPath $vsixPath -ExpectedVersion $expectedProductVersion -ExpectedAssembly $variant.Assembly

    $item = Get-Item -LiteralPath $vsixPath
    $hash = Get-FileHash -LiteralPath $vsixPath -Algorithm SHA256
    $builtVariants[$variant.Target] = $vsixPath
    [pscustomobject]@{
        Target = $variant.Target
        Path = $item.FullName
        Size = $item.Length
        SHA256 = $hash.Hash
    }
}

& (Join-Path $PSScriptRoot "Test-VsixRuntimeSmoke.ps1") `
    -Vsix17Path $builtVariants["17.0"] `
    -Vsix1712Path $builtVariants["17.12"]
