param(
    [string[]]$VsInstance,
    [switch]$KillVisualStudio,
    [switch]$ResetUserData,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$knownExtensionIds = @(
    "VsClineAgent.3F8C2A1D-E7B4-4F9E-A8C5-6D2B1F7E3A04",
    "VsClineAgent17.ADCC53D2-7B09-4F8D-8534-1FF693AED219"
)

function Write-Step([string]$Message) {
    Write-Host "[VsClineAgent clean] $Message"
}

function Get-ResolvedPathOrNull([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-UnderRoot([string]$Path, [string]$Root) {
    $resolvedPath = Get-ResolvedPathOrNull $Path
    $resolvedRoot = Get-ResolvedPathOrNull $Root
    if (-not $resolvedPath -or -not $resolvedRoot) {
        throw "Unable to resolve cleanup path or root. Path=$Path Root=$Root"
    }

    $rootWithSlash = $resolvedRoot.TrimEnd('\') + '\'
    if ($resolvedPath -ne $resolvedRoot -and -not $resolvedPath.StartsWith($rootWithSlash, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove outside cleanup root. Path=$resolvedPath Root=$resolvedRoot"
    }

    return $resolvedPath
}

function Remove-SafePath([string]$Path, [string]$Root) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $resolved = Assert-UnderRoot -Path $Path -Root $Root
    if ($DryRun) {
        Write-Step "Would remove $resolved"
        return
    }

    Write-Step "Removing $resolved"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Remove-Item -LiteralPath $resolved -Recurse -Force
            return
        }
        catch {
            if ($attempt -eq 3) {
                throw
            }

            Start-Sleep -Milliseconds 500
        }
    }
}

function Get-VsInstanceNames {
    if ($VsInstance -and $VsInstance.Count -gt 0) {
        return $VsInstance
    }

    $vsRoot = Join-Path $env:LOCALAPPDATA "Microsoft\VisualStudio"
    if (-not (Test-Path -LiteralPath $vsRoot)) {
        return @()
    }

    return Get-ChildItem -LiteralPath $vsRoot -Directory |
        Where-Object { $_.Name -match '^(17|18)\.0_' } |
        ForEach-Object { $_.Name }
}

function Stop-RelatedProcesses([string[]]$InstanceNames) {
    $devenv = Get-Process devenv -ErrorAction SilentlyContinue
    if ($devenv) {
        if (-not $KillVisualStudio) {
            throw "Close Visual Studio before cleaning, or pass -KillVisualStudio to stop devenv.exe automatically."
        }

        foreach ($process in $devenv) {
            Write-Step "Stopping devenv.exe PID $($process.Id)"
            if (-not $DryRun) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $instanceFragments = $InstanceNames | ForEach-Object { "\Microsoft\VisualStudio\$_\Extensions\" }
    $sidecars = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $commandLine = [string]$_.CommandLine
            $executablePath = [string]$_.ExecutablePath
            $looksLikeVsCline =
                $commandLine.IndexOf("cline-sidecar.js", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $commandLine.IndexOf("VsClineAgent", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $executablePath.IndexOf("VsClineAgent", [StringComparison]::OrdinalIgnoreCase) -ge 0

            if (-not $looksLikeVsCline) {
                return $false
            }

            foreach ($fragment in $instanceFragments) {
                if ($commandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                    $executablePath.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    return $true
                }
            }

            return $commandLine.IndexOf("\VsClineAgent\Sidecar\", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $commandLine.IndexOf("\AppData\Local\VsClineAgent\Sidecar\", [StringComparison]::OrdinalIgnoreCase) -ge 0
        }

    foreach ($sidecar in $sidecars) {
        Write-Step "Stopping stale sidecar node.exe PID $($sidecar.ProcessId)"
        if (-not $DryRun) {
            Stop-Process -Id $sidecar.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    if (($devenv -or $sidecars) -and -not $DryRun) {
        Start-Sleep -Milliseconds 700
    }
}

function Find-ExtensionFolders([string]$ExtensionsRoot) {
    if (-not (Test-Path -LiteralPath $ExtensionsRoot)) {
        return @()
    }

    $matches = foreach ($manifest in Get-ChildItem -LiteralPath $ExtensionsRoot -Recurse -Filter extension.vsixmanifest -ErrorAction SilentlyContinue) {
        try {
            $xml = [xml](Get-Content -LiteralPath $manifest.FullName)
            $id = [string]$xml.PackageManifest.Metadata.Identity.Id
            $displayName = [string]$xml.PackageManifest.Metadata.DisplayName
            if ($knownExtensionIds -contains $id -or
                $id.StartsWith("VsClineAgent", [StringComparison]::OrdinalIgnoreCase) -or
                $displayName.StartsWith("LIG VS", [StringComparison]::OrdinalIgnoreCase)) {
                $manifest.Directory.FullName
            }
        }
        catch {
        }
    }

    return $matches | Sort-Object -Unique
}

function Clear-VsInstanceCaches([string]$InstanceName) {
    $instanceRoot = Join-Path $env:LOCALAPPDATA "Microsoft\VisualStudio\$InstanceName"
    $extensionsRoot = Join-Path $instanceRoot "Extensions"
    if (-not (Test-Path -LiteralPath $instanceRoot)) {
        Write-Step "VS instance cache root not found: $instanceRoot"
        return
    }

    foreach ($folder in Find-ExtensionFolders -ExtensionsRoot $extensionsRoot) {
        Remove-SafePath -Path $folder -Root $extensionsRoot
    }

    Remove-SafePath -Path (Join-Path $instanceRoot "ComponentModelCache") -Root $instanceRoot
}

function Clear-VsClineRuntimeCaches {
    $localRoot = Join-Path $env:LOCALAPPDATA "VsClineAgent"
    if (-not (Test-Path -LiteralPath $localRoot)) {
        $localRoot = $null
    }

    if ($localRoot) {
        foreach ($name in @("Sidecar", "WebView2Data", "WebView2Runtime", "changes", "home")) {
            Remove-SafePath -Path (Join-Path $localRoot $name) -Root $localRoot
        }

        if ($ResetUserData) {
            foreach ($name in @("logs", "settings.json", "scheduled-runs.json")) {
                Remove-SafePath -Path (Join-Path $localRoot $name) -Root $localRoot
            }
        }
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "VsClineAgent"
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-SafePath -Path $tempRoot -Root ([System.IO.Path]::GetTempPath())
    }

    if ($ResetUserData) {
        $roamingRoot = Join-Path $env:APPDATA "VsClineAgent"
        if (Test-Path -LiteralPath $roamingRoot) {
            Remove-SafePath -Path $roamingRoot -Root $env:APPDATA
        }
    }
}

$instances = @(Get-VsInstanceNames)
if ($instances.Count -eq 0) {
    Write-Step "No Visual Studio instance cache folders found."
}

Stop-RelatedProcesses -InstanceNames $instances

foreach ($instance in $instances) {
    Write-Step "Cleaning Visual Studio instance $instance"
    Clear-VsInstanceCaches -InstanceName $instance
}

Clear-VsClineRuntimeCaches

Write-Step "Clean complete. Install the new VSIX and restart Visual Studio."
