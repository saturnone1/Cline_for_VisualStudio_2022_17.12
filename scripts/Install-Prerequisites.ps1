#Requires -RunAsAdministrator
param(
    [ValidateSet("17.0", "17.12")]
    [string]$VsTarget = "17.12",

    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent

Write-Host "=== LIG VS installation prerequisites ===" -ForegroundColor Cyan

$webView2RegistryPath = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$webView2 = Get-ItemProperty $webView2RegistryPath -ErrorAction SilentlyContinue
if ($webView2) {
    Write-Host "WebView2 Runtime detected: $($webView2.pv)" -ForegroundColor Green
}
else {
    $installer = Join-Path $repoRoot "vendor\installers\MicrosoftEdgeWebView2Setup.exe"
    if (Test-Path -LiteralPath $installer) {
        Write-Host "Installing bundled WebView2 Runtime..." -ForegroundColor Yellow
        $process = Start-Process -FilePath $installer -ArgumentList "/silent", "/install" -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "WebView2 installer failed with exit code $($process.ExitCode)."
        }
    }
    else {
        Write-Warning "WebView2 Runtime was not detected and no offline installer is bundled."
        Write-Host "Download it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and rerun this script."
        exit 1
    }
}

$vsixName = if ($VsTarget -eq "17.0") { "VsClineAgent17.vsix" } else { "VsClineAgent.vsix" }
$vsixPath = Join-Path $repoRoot "src\extension\bin\$VsTarget\$Configuration\$vsixName"
if (-not (Test-Path -LiteralPath $vsixPath)) {
    throw "VSIX was not found at $vsixPath. Run scripts\Build-VsixVariants.ps1 first."
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "vswhere.exe was not found. Install Visual Studio 2022 before installing the VSIX."
}

$versionRange = if ($VsTarget -eq "17.0") { "[17.0,17.12)" } else { "[17.12,18.0)" }
$installationPath = & $vswhere -latest -products * -version $versionRange -property installationPath
if (-not $installationPath) {
    throw "A Visual Studio instance matching target $VsTarget ($versionRange) was not found."
}

$vsixInstaller = Join-Path $installationPath "Common7\IDE\VSIXInstaller.exe"
if (-not (Test-Path -LiteralPath $vsixInstaller)) {
    throw "VSIXInstaller.exe was not found below $installationPath."
}

Write-Host "Installing $vsixName into Visual Studio $VsTarget..." -ForegroundColor Yellow
$installProcess = Start-Process -FilePath $vsixInstaller -ArgumentList "/quiet", $vsixPath -Wait -PassThru
if ($installProcess.ExitCode -ne 0) {
    throw "VSIX installation failed with exit code $($installProcess.ExitCode)."
}

Write-Host "Installation completed successfully." -ForegroundColor Green
