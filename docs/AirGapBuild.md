# VsClineAgent — 에어갭 빌드 & 설치 가이드

## 개요

| 단계 | 인터넷 필요 | 작업 내용 |
|------|------------|---------|
| 1. 패키지 다운로드 | ✅ 필요 | NuGet 패키지를 LocalPackages에 저장 |
| 2. 빌드 | ❌ 불필요 | WebView2 Fixed Runtime 포함 VSIX 생성 |
| 3. 설치 | ❌ 불필요 | VSIX 설치 |
| 4. 실행 | ❌ 불필요 | Ollama + VS 2022 실행 |

---

## Step 1 — 인터넷 PC에서 패키지 사전 다운로드

### 필수 조건
- Windows PC (인터넷 연결)
- Visual Studio 2022 17.12 + **"Visual Studio extension development"** 워크로드
- .NET SDK 8.0 이상 (`dotnet --version` 확인)

### 실행
```powershell
# PowerShell (관리자 불필요)
cd VsClineAgent
.\scripts\Download-Packages.ps1
```
→ `LocalPackages\` 폴더에 NuGet 패키지 저장됨

### 다운로드되는 패키지
| 패키지 | 버전 | 용도 |
|--------|------|------|
| Microsoft.VisualStudio.SDK | 17.6.36389 | VS 2022 VSIX 개발 API |
| Microsoft.VSSDK.BuildTools | 17.6.2164 | VSIX 빌드 도구 |
| Microsoft.Web.WebView2 | 1.0.2739.15 | 채팅 UI 렌더링 |
| Newtonsoft.Json | 13.0.3 | JSON 직렬화 |
| (transitive 의존성 포함) | — | — |

---

## Step 2 — WebView2 Fixed Version Runtime 준비

이 확장은 airgap PC에서 WebView2 온라인 설치 프로그램을 실행하지 않습니다. 인터넷 PC에서 Microsoft 공식 WebView2 Fixed Version Runtime CAB를 받은 뒤, 빌드 전에 VSIX에 포함합니다.

```powershell
# 예시 파일명
Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab
```

주의: `vendor/installers/MicrosoftEdgeWebView2Setup.exe`는 온라인 bootstrapper라 airgap 용도로 쓰지 않습니다. 또한 이미 설치된 `Program Files\Microsoft\EdgeWebView\Application\<version>` 폴더를 복사하면 Fixed Version Runtime으로 동작하지 않을 수 있습니다.

빌드 전에 다음 중 하나를 실행합니다.

```powershell
.\scripts\Bundle-WebView2Runtime.ps1 -SourceCab "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab"
```

또는 CAB를 미리 풀어둔 경우:

```powershell
.\scripts\Bundle-WebView2Runtime.ps1 -SourceRuntime "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64"
```

---

## Step 3 — 에어갭 PC로 파일 복사

아래 폴더/파일 전체를 에어갭 PC로 복사:
```
VsClineAgent\
├── LocalPackages\          ← Step 1에서 생성
├── downloads\
│   └── Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab   ← Step 2에서 다운로드
├── scripts\
├── VsClineAgent\
├── nuget.config
├── VsClineAgent.sln
└── (나머지 소스 파일들)
```

---

## Step 4 — 에어갭 PC에서 빌드

먼저 WebView2 Fixed Runtime을 VSIX 소스에 포함합니다.

```powershell
.\scripts\Bundle-WebView2Runtime.ps1 -SourceCab ".\downloads\Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab"
```

### 방법 A: Visual Studio 2022 GUI
1. `VsClineAgent.sln` 더블클릭 → VS 2022 열림
2. 솔루션 탐색기에서 우클릭 → **Restore NuGet Packages**
   - `nuget.config`가 `LocalPackages\`를 우선 참조하므로 인터넷 불필요
3. **Build → Build Solution** (`Ctrl+Shift+B`)
4. `src\extension\bin\Release\VsClineAgent.vsix` 생성 확인

> 만약 `bin\Release\` 에 없으면 `bin\Release\net472\VsClineAgent.vsix` 도 확인하세요.

### 방법 B: 명령줄
```powershell
cd VsClineAgent
msbuild VsClineAgent.sln /p:Configuration=Release /restore /p:RestorePackagesPath=.\LocalPackages
```

---

## Step 5 — 설치

`src\extension\bin\Release\VsClineAgent.vsix`를 더블클릭해서 설치한 뒤 Visual Studio 2022를 재시작합니다. WebView2 Fixed Runtime과 Cline SDK sidecar 런타임은 VSIX에 포함되어 있으므로 별도 온라인 설치가 필요 없습니다.

---

## Step 6 — Ollama 설정 (에어갭 LLM)

1. **Ollama for Windows** 설치:
   - 인터넷 PC: https://ollama.ai/download 에서 `OllamaSetup.exe` 다운로드
   - 에어갭 PC로 복사 후 설치

2. **모델 파일 복사** (인터넷 PC에서):
   ```powershell
   # 인터넷 PC에서 모델 다운로드
   ollama pull qwen3-coder:latest
   
   # 모델 파일 위치 (에어갭 PC로 복사)
   # Windows: C:\Users\<username>\.ollama\models\
   ```

3. **에어갭 PC에서 Ollama 실행**:
   ```
   ollama serve
   # → http://localhost:11434 에서 실행됨
   ```

---

## Step 7 — AI Agent 사용

1. Visual Studio 2022 열기
2. **View 메뉴 → AI Agent** 패널 열기
3. ⚙ 설정에서 확인:
   ```
   LLM Base URL: http://localhost:11434/v1
   Model Name:   qwen3-coder:latest
   ```
4. 채팅창에 작업 요청 입력

---

## 트러블슈팅

### 빌드 오류: "The type or namespace 'WebView2' could not be found"
→ NuGet restore가 안 된 것. Step 4의 Restore 단계 재실행

### 빌드 오류: "Cannot find PkgDef compiler"
→ VS 2022에 **"Visual Studio extension development"** 워크로드 미설치
→ VS Installer → 수정 → 워크로드 추가

### 패널 열면 WebView2 init failed
→ VSIX에 WebView2 Fixed Runtime이 포함되지 않았거나 잘못된 Evergreen 폴더를 복사한 상태입니다. Step 2/4의 `Bundle-WebView2Runtime.ps1`을 공식 Fixed Runtime CAB로 다시 실행한 뒤 재빌드/재설치합니다.

### "LLM error: Cannot connect"
→ Ollama가 실행 중인지 확인: `ollama serve` 또는 작업 표시줄 확인

### VSIX 설치 오류: "This extension is not installable on any currently installed products"
→ VS 2022 버전이 17.0~18.0 범위에 있는지 확인 (17.12 ✓)
