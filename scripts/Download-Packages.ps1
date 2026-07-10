# Download-Packages.ps1
# 에어갭 환경 빌드 준비용 — 인터넷 연결된 PC에서 실행
# 모든 NuGet 패키지를 ./vendor/LocalPackages 폴더에 다운로드

param(
    [string]$PackagesFolder = "$PSScriptRoot\..\vendor\LocalPackages"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$sln  = Join-Path $root "VsClineAgent.sln"

Write-Host "=== VsClineAgent 에어갭 패키지 다운로드 ===" -ForegroundColor Cyan
Write-Host "저장 경로: $PackagesFolder"
Write-Host ""

# dotnet restore로 로컬 폴더에 패키지 다운로드
Write-Host "[1/2] dotnet restore 실행 중..." -ForegroundColor Yellow
dotnet restore $sln --packages $PackagesFolder --no-cache
if ($LASTEXITCODE -ne 0) {
    # MSBuild restore 시도
    Write-Host "dotnet restore 실패 — MSBuild로 재시도..." -ForegroundColor Yellow
    $msbuild = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
        -latest -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe 2>$null |
        Select-Object -First 1
    if ($msbuild) {
        & $msbuild $sln /t:Restore /p:RestorePackagesPath="$PackagesFolder"
    } else {
        Write-Error "MSBuild를 찾을 수 없습니다. Visual Studio 2022 설치를 확인하세요."
    }
}

Write-Host ""
Write-Host "[2/2] 패키지 목록 확인..." -ForegroundColor Yellow
Get-ChildItem $PackagesFolder -Directory | ForEach-Object { Write-Host "  ✓ $($_.Name)" }

Write-Host ""
Write-Host "완료! LocalPackages 폴더를 에어갭 PC에 복사하세요." -ForegroundColor Green
Write-Host "에어갭 PC에서 빌드 시 nuget.config가 자동으로 로컬 피드를 사용합니다."
