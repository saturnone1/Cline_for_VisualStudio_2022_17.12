param(
    [string]$VsInstance = "18.0_3e1c691c"
)

$ErrorActionPreference = "Stop"

$devenv = Get-Process devenv -ErrorAction SilentlyContinue
if ($devenv) {
    throw "Close Visual Studio before cleaning VsClineAgent extension folders."
}

$extensionId = "VsClineAgent.3F8C2A1D-E7B4-4F9E-A8C5-6D2B1F7E3A04"
$root = Join-Path $env:LOCALAPPDATA "Microsoft\VisualStudio\$VsInstance\Extensions"
if (!(Test-Path $root)) {
    Write-Host "Extension root not found: $root"
    exit 0
}

$rootPath = (Resolve-Path $root).Path

$sidecars = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object {
        ($_.CommandLine -like "*cline-sidecar.js*" -or $_.CommandLine -like "*VsClineAgent*") -and
        (
            ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) -or
            ($_.CommandLine -and $_.CommandLine.IndexOf("\VsClineAgent\Sidecar\", [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
            ($_.CommandLine -and $_.CommandLine.IndexOf("\Microsoft\VisualStudio\$VsInstance\Extensions\", [StringComparison]::OrdinalIgnoreCase) -ge 0)
        )
    }

foreach ($sidecar in $sidecars) {
    Write-Host "Stopping stale VsClineAgent sidecar node.exe PID $($sidecar.ProcessId)"
    Stop-Process -Id $sidecar.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($sidecars) {
    Start-Sleep -Milliseconds 500
}

$matches = foreach ($manifest in Get-ChildItem -Path $rootPath -Recurse -Filter extension.vsixmanifest) {
    try {
        $xml = [xml](Get-Content -LiteralPath $manifest.FullName)
        if ($xml.PackageManifest.Metadata.Identity.Id -eq $extensionId) {
            $manifest.Directory.FullName
        }
    }
    catch {
    }
}

$matches = $matches | Sort-Object -Unique
if (!$matches) {
    Write-Host "No VsClineAgent extension folders found under $rootPath"
    exit 0
}

foreach ($folder in $matches) {
    $resolved = (Resolve-Path $folder).Path
    if (!$resolved.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove outside extension root: $resolved"
    }

    Write-Host "Removing $resolved"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Remove-Item -LiteralPath $resolved -Recurse -Force
            break
        }
        catch {
            if ($attempt -eq 3) {
                throw
            }

            Start-Sleep -Milliseconds 500
        }
    }
}

Write-Host "Clean complete. Install the new VSIX and restart Visual Studio."
