param(
    [Parameter(Mandatory = $true)]
    [string]$Vsix17Path,

    [Parameter(Mandatory = $true)]
    [string]$Vsix1712Path
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Fail([string]$Message) {
    throw "[VSIX runtime smoke failed] $Message"
}

function Read-ZipEntryHash($Zip, [string]$EntryName) {
    $entry = $Zip.GetEntry($EntryName)
    if (-not $entry) { Fail "Missing entry: $EntryName" }
    $stream = $entry.Open()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Assert-CommonPayload([string]$FirstPath, [string]$SecondPath) {
    $first = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $FirstPath).Path)
    $second = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $SecondPath).Path)
    try {
        $firstNames = @($first.Entries | Where-Object { $_.FullName.StartsWith("Sidecar/") -or $_.FullName.StartsWith("WebApp/") } | ForEach-Object FullName | Sort-Object)
        $secondNames = @($second.Entries | Where-Object { $_.FullName.StartsWith("Sidecar/") -or $_.FullName.StartsWith("WebApp/") } | ForEach-Object FullName | Sort-Object)
        if (($firstNames -join "`n") -ne ($secondNames -join "`n")) { Fail "17.0 and 17.12 common payload entry sets differ." }
        foreach ($name in $firstNames) {
            if ((Read-ZipEntryHash $first $name) -ne (Read-ZipEntryHash $second $name)) {
                Fail "17.0 and 17.12 common payload differs: $name"
            }
        }
        Write-Host "Common Sidecar/WebApp payload parity passed ($($firstNames.Count) entries)."
    }
    finally { $first.Dispose(); $second.Dispose() }
}

function Send-PipeRequest($Reader, $Writer, [string]$Id, [string]$Method, $Params) {
    $request = @{ id = $Id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 20
    $Writer.WriteLine($request)
    $Writer.Flush()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        $readTask = $Reader.ReadLineAsync()
        if (-not $readTask.Wait(15000)) { Fail "Timed out waiting for $Method response." }
        $line = $readTask.Result
        if ($null -eq $line) { Fail "Sidecar pipe closed while waiting for $Method." }
        $message = $line | ConvertFrom-Json
        if ($message.method) {
            $Writer.WriteLine((@{ id = [string]$message.id; result = @{} } | ConvertTo-Json -Compress))
            $Writer.Flush()
            continue
        }
        if ([string]$message.id -ne $Id) { continue }
        if ($message.error) { Fail "$Method returned an error: $($message.error | ConvertTo-Json -Compress)" }
        return $message.result
    }
    Fail "Timed out waiting for matching $Method response."
}

function Invoke-RuntimeSmoke([string]$VsixPath, [string]$Label) {
    $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    # Keep this deliberately short: the SDK dependency tree contains paths near
    # the legacy MAX_PATH limit used by Windows PowerShell's ZipFile API.
    $tempRoot = Join-Path $tempBase ("lvs-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    [System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
    $process = $null
    try {
        [System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path -LiteralPath $VsixPath).Path, $tempRoot)
        $runtime = Join-Path $tempRoot "Sidecar\runtime"
        $nodeModulesArchive = Join-Path $tempRoot "Sidecar\node_modules.zip"
        $nodeModules = Join-Path $runtime "node_modules"
        foreach ($required in @(
            (Join-Path $runtime "node.exe"),
            (Join-Path $runtime "cline-sidecar.js"),
            (Join-Path $runtime "bootstrap\SidecarConnectionFactory.js"),
            $nodeModulesArchive,
            (Join-Path $tempRoot "VsClineAgent.pkgdef")
        )) { if (-not (Test-Path -LiteralPath $required)) { Fail "$Label missing installed payload: $required" } }

        $pkgDefText = Get-Content -LiteralPath (Join-Path $tempRoot "VsClineAgent.pkgdef") -Raw
        $codeBaseMatch = [regex]::Match($pkgDefText, '"CodeBase"="\$PackageFolder\$\\(?<assembly>[^"\\]+\.dll)"')
        if (-not $codeBaseMatch.Success) { Fail "$Label pkgdef has no package assembly CodeBase." }
        $assemblyPath = Join-Path $tempRoot $codeBaseMatch.Groups["assembly"].Value
        if (-not (Test-Path -LiteralPath $assemblyPath)) { Fail "$Label pkgdef points to a missing assembly: $assemblyPath" }

        [System.IO.Compression.ZipFile]::ExtractToDirectory($nodeModulesArchive, $nodeModules)
        $pipeLeaf = "VsClineAgent-smoke-" + [Guid]::NewGuid().ToString("N")
        $pipePath = "\\.\pipe\$pipeLeaf"
        $start = [System.Diagnostics.ProcessStartInfo]::new()
        $start.FileName = Join-Path $runtime "node.exe"
        $start.Arguments = '"' + (Join-Path $runtime "cline-sidecar.js") + '" --pipe "' + $pipePath + '"'
        $start.WorkingDirectory = $runtime
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::Start($start)

        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(".", $pipeLeaf, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
        try {
            $pipe.Connect(15000)
            $reader = [System.IO.StreamReader]::new($pipe, [System.Text.UTF8Encoding]::new($false))
            $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false))
            $writer.AutoFlush = $true
            try {
                $health = Send-PipeRequest $reader $writer "health-1" "health.ping" @{ source = "vsix-smoke" }
                if ($health.status -ne "ok" -or $health.protocol -ne 1) { Fail "$Label returned an invalid health response." }

                $webviewEnvelope = @{
                    protocol_version = 1
                    type = "grpc_request"
                    grpc_request = @{
                        service = "StateService"
                        method = "subscribeToState"
                        request_id = "state-smoke-1"
                        is_streaming = $true
                        message = @{}
                    }
                } | ConvertTo-Json -Compress -Depth 10
                $webview = Send-PipeRequest $reader $writer "webview-1" "webview.message" @{
                    protocolVersion = 1
                    rawJson = $webviewEnvelope
                }
                if ($webview.handled -ne $true -or @($webview.webviewMessages).Count -lt 1) { Fail "$Label initial WebView state RPC was not handled." }

				$stateResponse = @($webview.webviewMessages | Where-Object {
					$_.type -eq "grpc_response" -and $_.grpc_response.request_id -eq "state-smoke-1"
				}) | Select-Object -First 1
				if (-not $stateResponse) { Fail "$Label initial WebView state RPC returned no matching gRPC response." }
				if ($stateResponse.protocol_version -ne 1 -or $stateResponse.grpc_response.is_streaming -ne $true) {
					Fail "$Label initial WebView state RPC returned an invalid protocol or stream flag."
				}
				$stateJson = [string]$stateResponse.grpc_response.message.stateJson
				if ([string]::IsNullOrWhiteSpace($stateJson)) { Fail "$Label initial WebView state RPC returned an empty stateJson payload." }
				try { $initialState = $stateJson | ConvertFrom-Json }
				catch { Fail "$Label initial WebView state RPC returned malformed stateJson: $($_.Exception.Message)" }
				if ([string]::IsNullOrWhiteSpace([string]$initialState.version) -or -not $initialState.apiConfiguration) {
					Fail "$Label initial WebView state RPC returned an incomplete initial state."
				}
            }
            finally { $writer.Dispose(); $reader.Dispose() }
        }
        finally { $pipe.Dispose() }
        Write-Host "$Label runtime health and initial WebView state smoke passed."
    }
    finally {
        if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
        if (-not $resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { Fail "Unsafe temp cleanup path: $resolvedTemp" }
        if (Test-Path -LiteralPath $resolvedTemp) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
    }
}

Assert-CommonPayload $Vsix17Path $Vsix1712Path
Invoke-RuntimeSmoke $Vsix17Path "VS 2022 17.0"
Invoke-RuntimeSmoke $Vsix1712Path "VS 2022 17.12"
Write-Host "Dual VSIX runtime smoke passed."
