param(
    [string]$SourceRuntime,
    [string]$SourceCab,
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

if (![string]::IsNullOrWhiteSpace($SourceCab)) {
    if (!(Test-Path $SourceCab)) {
        throw "WebView2 Fixed Version Runtime CAB was not found: $SourceCab"
    }

    $extractRoot = Join-Path $ProjectRoot ".webview2-fixed-extract"
    if (Test-Path $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }

    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    expand $SourceCab -F:* $extractRoot | Out-Null

    $SourceRuntime = Get-ChildItem -Path $extractRoot -Directory -Recurse |
        Where-Object {
            $_.Name -like "Microsoft.WebView2.FixedVersionRuntime.*.x64" -and
            (Test-Path (Join-Path $_.FullName "msedgewebview2.exe"))
        } |
        Select-Object -First 1 -ExpandProperty FullName
}

if ([string]::IsNullOrWhiteSpace($SourceRuntime) -or !(Test-Path (Join-Path $SourceRuntime "msedgewebview2.exe"))) {
    throw "WebView2 Fixed Version Runtime was not found. Pass -SourceCab with Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab, or pass -SourceRuntime pointing to an extracted Microsoft.WebView2.FixedVersionRuntime.<version>.x64 folder."
}

$runtimeFolderName = Split-Path $SourceRuntime -Leaf
if ($runtimeFolderName -notlike "Microsoft.WebView2.FixedVersionRuntime.*.x64") {
    throw "The source does not look like an official Fixed Version Runtime folder: $SourceRuntime. Do not pass an installed Evergreen folder such as Program Files\Microsoft\EdgeWebView\Application\<version>."
}

$version = $runtimeFolderName -replace "^Microsoft\.WebView2\.FixedVersionRuntime\.", "" -replace "\.x64$", ""
$targetRoot = Join-Path $ProjectRoot "VsClineAgent\WebView2Runtime"
$target = Join-Path $targetRoot $runtimeFolderName

if (Test-Path $targetRoot) {
    Remove-Item -LiteralPath $targetRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
robocopy $SourceRuntime $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

Write-Host "Bundled WebView2 Runtime:"
Write-Host "  Source: $SourceRuntime"
Write-Host "  Target: $target"
Write-Host "  Version: $version"
