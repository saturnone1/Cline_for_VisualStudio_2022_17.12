param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",

    [string]$MSBuildPath,

    [string]$NodeRuntimeArchive,

    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent

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
    throw "Visual Studio 2022 MSBuild was not found. Pass -MSBuildPath explicitly."
}

$installationRoot = Split-Path (Split-Path (Split-Path (Split-Path $MSBuildPath -Parent) -Parent) -Parent) -Parent
$vsToolsPath = Join-Path $installationRoot "MSBuild\Microsoft\VisualStudio\v17.0"
if (-not (Test-Path -LiteralPath $vsToolsPath)) {
    throw "Visual Studio 2022 VSSDK targets were not found at $vsToolsPath"
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
    Invoke-Checked "npm.cmd" @("run", "build") (Join-Path $repoRoot "src\sidecar")
    Invoke-Checked "npm.cmd" @("run", "build") (Join-Path $repoRoot "src\webview")
}

$variants = @(
    @{ Target = "17.0"; Assembly = "VsClineAgent17.dll"; Vsix = "VsClineAgent17.vsix" },
    @{ Target = "17.12"; Assembly = "VsClineAgent.dll"; Vsix = "VsClineAgent.vsix" }
)

foreach ($variant in $variants) {
    $msbuildArguments = @(
        (Join-Path $repoRoot "VsClineAgent.sln"),
        "/restore",
        "/t:Rebuild",
        "/p:VsTarget=$($variant.Target)",
        "/p:Configuration=$Configuration",
        "/p:DeployExtension=false",
        "/p:VSToolsPath=$vsToolsPath",
        "/v:minimal"
    )
    Invoke-Checked $MSBuildPath $msbuildArguments $repoRoot

    $vsixPath = Join-Path $repoRoot "src\extension\bin\$($variant.Target)\$Configuration\$($variant.Vsix)"
    & (Join-Path $PSScriptRoot "Test-VsixPackage.ps1") -VsixPath $vsixPath -ExpectedVersion "2.0.0" -ExpectedAssembly $variant.Assembly

    $item = Get-Item -LiteralPath $vsixPath
    $hash = Get-FileHash -LiteralPath $vsixPath -Algorithm SHA256
    [pscustomobject]@{
        Target = $variant.Target
        Path = $item.FullName
        Size = $item.Length
        SHA256 = $hash.Hash
    }
}
