# Install-Prerequisites.ps1
# 에어갭 PC에서 VSIX 설치 전 필수 구성 요소 설치
# 관리자 권한으로 실행 필요

#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

Write-Host "=== VsClineAgent 사전 요구사항 설치 ===" -ForegroundColor Cyan

# ── 1. WebView2 Runtime 확인 ──────────────────────────────────
Write-Host "`n[1/2] WebView2 Runtime 확인..." -ForegroundColor Yellow

$webview2 = Get-ItemProperty `
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" `
    -ErrorAction SilentlyContinue

if ($webview2) {
    Write-Host "  ✓ WebView2 Runtime 이미 설치됨: $($webview2.pv)" -ForegroundColor Green
} else {
    Write-Host "  WebView2 Runtime이 없습니다." -ForegroundColor Red

    # vendor/installers에 WebView2 bootstrapper가 있으면 자동 설치
    $installer = Join-Path $PSScriptRoot "..\vendor\installers\MicrosoftEdgeWebView2Setup.exe"
    if (Test-Path $installer) {
        Write-Host "  설치 파일 발견 — 설치 중..." -ForegroundColor Yellow
        Start-Process $installer -ArgumentList "/silent /install" -Wait
        Write-Host "  ✓ WebView2 Runtime 설치 완료" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  ▶ 오프라인 설치 방법:" -ForegroundColor Yellow
        Write-Host "    1. 인터넷 PC에서 다운로드:"
        Write-Host "       https://go.microsoft.com/fwlink/p/?LinkId=2124703"
        Write-Host "    2. MicrosoftEdgeWebView2Setup.exe를 vendor\installers\ 폴더에 복사"
        Write-Host "    3. 이 스크립트 재실행"
        Write-Host ""
        Write-Host "  ※ 또는 수동 설치 후 계속 진행하세요."
    }
}

# ── 2. VSIX 설치 ───────────────────────────────────────────────
Write-Host "`n[2/2] VsClineAgent VSIX 설치..." -ForegroundColor Yellow

$vsix = Get-ChildItem (Split-Path $PSScriptRoot -Parent) -Filter "*.vsix" -Recurse |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $vsix) {
    Write-Host "  .vsix 파일을 찾을 수 없습니다." -ForegroundColor Red
    Write-Host "  프로젝트를 빌드하거나 Release에서 .vsix를 다운로드하세요."
    exit 1
}

Write-Host "  설치할 파일: $($vsix.FullName)"

$vsInstaller = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
    -latest -property installationPath 2>$null
$vsixInstaller = Join-Path $vsInstaller "Common7\IDE\VSIXInstaller.exe"

if (Test-Path $vsixInstaller) {
    Write-Host "  VSIXInstaller 실행 중..."
    Start-Process $vsixInstaller -ArgumentList "/quiet `"$($vsix.FullName)`"" -Wait
    Write-Host "  ✓ VSIX 설치 완료" -ForegroundColor Green
    Write-Host "  Visual Studio 2022를 재시작하면 View 메뉴에 'AI Agent'가 표시됩니다."
} else {
    Write-Host "  VSIXInstaller를 찾을 수 없습니다. .vsix 파일을 더블클릭하여 수동 설치하세요." -ForegroundColor Yellow
    Start-Process $vsix.FullName
}

Write-Host "`n=== 완료 ===" -ForegroundColor Green
