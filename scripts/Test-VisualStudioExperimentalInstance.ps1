[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VsixPath,
    [string]$RootSuffix = "LIGVSSmoke",
    [int]$StartupSeconds = 25
)

$ErrorActionPreference = "Stop"

function Get-LigVsSidecars {
	@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
		$_.CommandLine -match "(?i)cline-sidecar\.js"
	})
}

function Wait-ForSidecarExit([int[]]$ProcessIds, [int]$TimeoutSeconds = 15) {
	$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
	do {
		$remaining = @(Get-LigVsSidecars | Where-Object { $ProcessIds -contains [int]$_.ProcessId })
		if ($remaining.Count -eq 0) { return }
		Start-Sleep -Milliseconds 250
	} while ([DateTime]::UtcNow -lt $deadline)
	throw "LIG VS sidecar processes remained after Visual Studio exit: $($remaining.ProcessId -join ', ')"
}

$resolvedVsix = (Resolve-Path -LiteralPath $VsixPath).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) { throw "vswhere.exe was not found." }
$installation = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if (-not $installation) { throw "Visual Studio was not found." }

$devenv = Join-Path $installation "Common7\IDE\devenv.exe"
$installer = Join-Path $installation "Common7\IDE\VSIXInstaller.exe"
if (-not (Test-Path -LiteralPath $devenv) -or -not (Test-Path -LiteralPath $installer)) {
    throw "Visual Studio experimental-instance tools were not found."
}

$install = Start-Process -FilePath $installer -ArgumentList @("/quiet", "/rootSuffix:$RootSuffix", $resolvedVsix) -Wait -PassThru -WindowStyle Hidden
if ($install.ExitCode -ne 0) { throw "VSIXInstaller failed with exit code $($install.ExitCode)." }

$activityLog = Join-Path ([IO.Path]::GetTempPath()) "VsClineAgent-$RootSuffix-ActivityLog.xml"
if (Test-Path -LiteralPath $activityLog) { Remove-Item -LiteralPath $activityLog -Force }
$baselineSidecarIds = @(Get-LigVsSidecars | ForEach-Object { [int]$_.ProcessId })
$startedSidecarIds = @()
$process = Start-Process -FilePath $devenv -ArgumentList @("/RootSuffix", $RootSuffix, "/Command", "View.LIGVS", "/Log", $activityLog) -PassThru -WindowStyle Hidden
try {
	Start-Sleep -Seconds $StartupSeconds
	if ($process.HasExited) { throw "Visual Studio exited before the LIG VS ToolWindow startup smoke completed." }
	$startedSidecarIds = @(Get-LigVsSidecars | Where-Object { $baselineSidecarIds -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
	if ($startedSidecarIds.Count -eq 0) { throw "The LIG VS ToolWindow did not start a sidecar process." }
}
finally {
    if (-not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        if (-not $process.WaitForExit(10000)) { $process.Kill(); $process.WaitForExit() }
	}
	if ($startedSidecarIds.Count -gt 0) { Wait-ForSidecarExit $startedSidecarIds }
}

if (-not (Test-Path -LiteralPath $activityLog)) { throw "Visual Studio did not produce an activity log." }
[xml]$log = Get-Content -LiteralPath $activityLog
$errors = @($log.SelectNodes("//*[local-name()='entry']") | Where-Object {
    $text = $_.InnerText
    $text -match "(?i)(VsClineAgent|LIG VS|3F8C2A1D-E7B4-4F9E-A8C5-6D2B1F7E3A04)" -and
    $text -match "(?i)(error|exception|failed)"
})
if ($errors.Count -gt 0) {
    throw "Visual Studio reported LIG VS package or ToolWindow errors:`n$($errors.InnerText -join "`n")"
}

Write-Host "Visual Studio experimental-instance ToolWindow startup and shutdown smoke passed."
