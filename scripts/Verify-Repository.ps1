[CmdletBinding()]
param(
	[switch]$SkipVsix,
	[switch]$RequireTrackedArtifacts,
	[switch]$RunExperimentalVs,
	[string]$ExperimentalRootSuffix = "LIGVSSmoke"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    Write-Host "==> $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE."
    }
}

Push-Location (Join-Path $repoRoot "src\sidecar")
try {
    Invoke-Step "Sidecar tests and architecture checks" { npm test }
    Invoke-Step "Sidecar production build" { npm run build }
}
finally { Pop-Location }

Push-Location (Join-Path $repoRoot "src\webview")
try {
	Invoke-Step "WebView hook-order lint" { npm run lint }
	Invoke-Step "WebView localization audit" { npm run i18n:audit }
	Invoke-Step "WebView tests" { npm test }
	Invoke-Step "WebView production build and snapshot" { npm run build }
	if ($RequireTrackedArtifacts) {
		Invoke-Step "Tracked WebApp snapshot" { npm run snapshot:tracked }
	}
}
finally { Pop-Location }

Push-Location $repoRoot
try {
    Invoke-Step ".NET host tests" { dotnet test .\tests\extension\VsClineAgent.Host.Tests.csproj -c Release --logger "console;verbosity=minimal" }
	if (-not $SkipVsix) {
		Invoke-Step "Dual VSIX build and runtime smoke" { .\scripts\Build-VsixVariants.ps1 -Configuration Release -SkipFrontend }
		if ($RunExperimentalVs) {
			$vsixPath = Join-Path $repoRoot "src\extension\bin\17.12\Release\VsClineAgent.vsix"
			Invoke-Step "Visual Studio experimental-instance lifecycle smoke" { .\scripts\Test-VisualStudioExperimentalInstance.ps1 -VsixPath $vsixPath -RootSuffix $ExperimentalRootSuffix }
		}
	}
}
finally { Pop-Location }
