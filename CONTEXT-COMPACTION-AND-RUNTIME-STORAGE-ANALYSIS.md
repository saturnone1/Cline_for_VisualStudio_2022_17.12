# 컨텍스트 압축 실패와 런타임 저장공간 증가 분석

## 문서 목적

이 문서는 다음 두 문제를 코드 기준으로 분석하고, 재현·진단·개선 방향을 기록한다.

1. 대화 컨텍스트가 모델 한도를 넘은 뒤 수동 압축도 같은 컨텍스트 길이 오류로 실패하는 문제
2. `%LOCALAPPDATA%\VsClineAgent` 아래 로그, Sidecar, WebView2 관련 폴더가 계속 커지는 문제

분석 기준은 2026-07-15의 `main` 브랜치이며, 관련 핵심 코드는 다음 위치에 있다.

- `src/sidecar/src/features/chat/runtime/CompactSessionFlow.ts`
- `src/sidecar/src/infrastructure/configuration/AgentSdkConfigBuilder.ts`
- `src/sidecar/src/features/chat/runtime/AgentRunRecoveryFlow.ts`
- `src/sidecar/src/infrastructure/persistence/JsonStateStore.ts`
- `src/sidecar/src/infrastructure/diagnostics/InteractionLog.ts`
- `src/extension/Host/InteractionLog.cs`
- `src/extension/Host/SidecarRuntimeInstaller.cs`
- `src/extension/Host/WebView2RuntimeResolver.cs`
- `scripts/Clean-VsClineAgentInstall.ps1`

## 결론 요약

### 컨텍스트 압축

현재 수동 압축은 이미 쌓인 대화를 로컬에서 줄이는 기능이 아니다. 기존 SDK 세션에 "현재 대화를 압축해 달라"는 유지보수 프롬프트를 일반 사용자 메시지처럼 추가 전송한다. 따라서 세션이 이미 모델 입력 한도를 넘었다면 압축 요청 자체도 같은 한도 오류로 거절될 수 있다.

이는 복구 경로로서 구조적인 결함이다. 정상 범위에서 미리 실행되는 자동 압축은 유효할 수 있지만, 한도 초과 이후에는 동일 세션에 의존하지 않는 별도 복구 압축이 필요하다.

### 저장공간

저장공간 문제는 폴더마다 성격이 다르다.

- `logs`: 날짜별 파일의 보존기간이나 총용량 제한이 없어 장기적으로 무제한 누적된다.
- `settings.json`: 대화 메시지와 작업 스냅샷을 한 파일에 저장하며 전체 크기 제한이나 오래된 작업 정리가 없다.
- `Sidecar`: 현재 버전 외 최근 구버전 2개를 남기므로 정상적으로도 최대 3개 런타임 사본이 존재한다. 삭제 실패가 무시되므로 잠긴 폴더는 그 이상 누적될 수 있다.
- `WebView2Data`: 버전별 최근 구버전 2개를 남기며, 현재 프로필 내부 Chromium 캐시에 별도 총용량 제한이나 주기적 청소가 없다.
- `WebView2Runtime`: 로컬 캐시 폴더를 탐색만 하며 버전 정리 로직이 없다. 여러 Fixed Runtime을 수동 배치하면 계속 남는다.
- VSIX 설치 폴더: Fixed Runtime과 Sidecar 패키지가 VSIX에 포함되므로 Visual Studio가 남긴 구버전 확장 디렉터리에도 큰 사본이 존재할 수 있다.

따라서 사용자가 관찰한 증상은 타당하다. 일부 폴더는 의도상 세대 제한이 있지만, 제품 전체 관점에서는 총용량 상한과 신뢰할 수 있는 정리 정책이 없다.

## 기본 저장 위치

기본 루트는 다음과 같다.

```text
%LOCALAPPDATA%\VsClineAgent
```

일반적인 하위 구조는 다음과 같다.

```text
VsClineAgent\
├─ settings.json
├─ settings.json.bak
├─ logs\
│  ├─ interaction-YYYYMMDD.jsonl
│  └─ interaction-YYYYMMDD.jsonl.1
├─ Sidecar\
│  ├─ <현재 assembly-name-version>\
│  └─ <이전 버전들>\
├─ WebView2Data\
│  └─ <assembly-name-version>\<runtime-id>\
├─ WebView2Runtime\
│  └─ Microsoft.WebView2.FixedVersionRuntime.<version>.x64\
├─ changes\
└─ home\
```

`VSCLINE_SETTINGS_DIR` 환경변수가 설정되면 `settings.json`만 지정 디렉터리로 이동할 수 있다. interaction 로그와 런타임 캐시는 계속 `%LOCALAPPDATA%\VsClineAgent`를 사용한다.

## 1. 컨텍스트 압축 결함 상세 분석

### 관찰된 증거

문제 로그에는 다음과 같은 사용량이 기록되어 있었다.

```json
{
  "tokensIn": 235666,
  "tokensOut": 125,
  "usageReliable": true
}
```

그 다음 요청에는 13만 자 이상 잘린 도구 결과가 포함되어 있었다.

```text
[truncated 133312 chars]
```

이 구간에는 성공한 압축 경계로 판단할 수 있는 `Compacting context...`, `컨텍스트 압축 중`, 압축 요약 결과가 보이지 않는다. 약 23.5만 입력 토큰이 실제 모델의 컨텍스트 한도에 가깝거나 초과했다면 다음 요청과 수동 압축이 모두 실패할 수 있다.

### 수동 압축의 현재 동작

`CompactSessionFlow`는 현재/선택 세션 ID를 찾은 뒤 다음 의미의 프롬프트를 만든다.

```text
이후 대화를 위해 현재 대화 컨텍스트를 압축해 주세요.
사용자의 목표, 결정, 파일 경로, 오류와 남은 작업을 보존하세요.
```

그 뒤 일반 메시지 전송과 같은 `sendOrResumeSession` 경로로 동일 세션에 보낸다. 즉, 압축 전에 기존 메시지를 제거하거나 별도 축약 입력을 만들지 않는다.

```text
기존의 과대 컨텍스트
  + 압축 요청 프롬프트
  → 동일 모델 API 호출
  → context length 오류
  → 요약 생성 실패
  → 기존 과대 컨텍스트 유지
```

이 상태에서는 사용자가 압축 버튼을 다시 눌러도 실패 조건이 그대로 유지된다.

### 자동 압축 조건

SDK 설정에는 다음 값이 전달된다.

```text
enabled       = useAutoCondense === true
strategy      = basic
thresholdRatio = 0.9
maxInputTokens = 감지 또는 설정된 모델 컨텍스트 길이
```

문제 가능성은 다음과 같다.

1. `useAutoCondense` 기본값은 `false`다.
2. provider/model metadata에서 컨텍스트 길이를 잘못 추론하면 임계점도 틀어진다.
3. 큰 도구 결과 하나가 추가되면 90% 아래에서 한도를 바로 넘어설 수 있다.
4. 자동 압축을 늦게 켜면 이미 초과된 세션에는 소용이 없다.
5. SDK가 압축을 위해 다시 모델을 호출하는 방식이라면 이미 초과된 상태에서 동일하게 실패한다.

### 오류 후 세션 상태 문제

Promise 기반 실행 실패는 `AgentRunRecoveryFlow`가 세션 재조회, 부분 응답 복구, 최종 `failed` 전환을 시도한다. 반면 SDK의 `AgentError` 이벤트 경로는 오류 메시지를 transcript에 추가하지만 그 이벤트만으로 즉시 작업을 `failed`로 끝내지 않는다.

SDK가 이후 `RunFailed` 또는 Promise reject를 확실히 전달하지 않으면 UI가 실행 중/완료/실패 상태를 일관되게 판단하지 못할 가능성이 있다. 실제 로그의 `completion_result: "완료"`는 모델이 충분한 최종 답을 했다는 보장이라기보다 wrapper가 실행을 완료로 투영한 결과일 수 있다.

### 압축 중 사용량이 0부터 증가하다가 완료 후 이전 수치로 돌아오는 문제

사용자가 관찰한 다음 현상은 현재 코드 흐름으로 설명된다.

1. 수동 압축을 시작하면 사용량 표시가 0에 가까운 값부터 다시 증가한다.
2. 압축 요약과 완료 응답이 화면에 표시되는 동안에는 낮은 수치가 유지된다.
3. 실행이 완전히 끝난 뒤에는 압축 전의 큰 사용량을 포함한 값으로 되돌아간다.

이것은 단순한 렌더링 지연이 아니라, live projection과 SDK transcript 재수화가 서로 다른 메시지 집합을 사용하기 때문에 발생하는 일관성 결함이다.

#### 압축 중 낮아지는 이유

`CompactSessionFlow`는 live transcript에 다음 reasoning 진행 메시지를 넣는다.

```text
Compacting context...
컨텍스트 압축 중입니다.
```

WebView의 `getCurrentContextMessages()`는 이 reasoning 메시지 뒤에 assistant text가 하나라도 있으면 그것을 "성공한 압축 경계"로 판단한다. 이후 사용량 계산에서 경계 이전의 모든 메시지를 제외한다.

```text
[기존 전체 대화와 큰 usage]
[Compacting context...]       ← 임시 경계
[새 요약/assistant text]
```

따라서 요약 text가 도착하는 순간 WebView는 실제 SDK history가 줄었는지 확인하지 않고, 새 요약 이후의 짧은 메시지만 토큰으로 추정한다. 사용량이 0 부근에서 다시 증가하는 것처럼 보이는 이유다.

이 판정에는 다음 문제가 있다.

- reasoning 진행 메시지가 있다는 사실을 압축 성공 증거로 사용한다.
- assistant text가 압축 요약인지 일반 응답인지 확인하지 않는다.
- SDK가 실제 활성 컨텍스트를 교체했는지 확인하지 않는다.
- 압축 전후 session ID, compaction ID, usage snapshot을 비교하지 않는다.

즉 압축 중 보이는 낮은 수치는 실제 provider/SDK가 보고한 신뢰 가능한 사용량이 아니라 UI의 낙관적 추정치다.

#### 완료 후 다시 커지는 이유

`AgentRunCompletionFlow.complete()`는 실행 결과가 오면 `hydrateCurrent(..., force=true)`를 먼저 호출한다. 이 과정은 SDK의 `getSession/readMessages` 결과를 다시 읽고, 현재 live `clineMessages`를 `sdkMessagesToClineMessages()`로 재구성한 transcript로 교체한다.

로컬에서만 만든 `Compacting context...` reasoning 메시지는 SDK 원본 message history에 반드시 존재하지 않는다. 재수화 후 이 임시 경계가 사라지면 `findLastSuccessfulCompactionBoundaryIndex()`는 압축 경계를 찾지 못하고 전체 transcript를 현재 컨텍스트로 간주한다.

```text
압축 실행 중 live projection
  → 로컬 reasoning 경계 존재
  → 경계 이후만 계산
  → 낮은 사용량 표시

압축 완료 후 SDK hydration
  → SDK 전체 history로 메시지 배열 교체
  → 로컬 reasoning 경계 소실
  → 과거 전체 메시지와 usage를 다시 계산
  → 큰 사용량으로 복귀
```

SDK transcript의 assistant message에 metrics가 있으면 `api_req_started` 형태의 신뢰 가능 usage가 다시 만들어진다. 과거의 큰 usage snapshot도 transcript에 남아 있을 수 있다. 또한 계산 함수 `getCalibratedConversationUsage()`는 보고된 값뿐 아니라 화면에 보이는 전체 대화의 추정 토큰도 계산하고 그중 큰 값을 선택한다.

```text
max(보정된 reported usage, 전체 visible conversation 추정값)
```

따라서 SDK가 내부적으로 일부 컨텍스트를 줄였더라도, archival transcript 전체를 반환하고 명시적인 compaction 경계를 제공하지 않으면 UI는 다시 큰 값을 표시할 수 있다.

#### 더 근본적인 문제

현재 수동 압축 구현은 SDK의 명시적인 `compactSession`, `replaceHistory`, `forkSessionWithSummary` 같은 API를 호출하지 않는다. 동일 세션에 유지보수 프롬프트를 일반 메시지로 전송할 뿐이다.

그러므로 두 가능성을 구분해야 한다.

1. **실제 압축도 안 된 경우**: 모델이 요약 답변만 생성했고 기존 SDK history는 그대로다. 완료 후 큰 수치가 실제 상태에 더 가깝고, 압축 중 0부터 보인 값이 잘못된 표시다.
2. **SDK 내부 압축은 됐지만 transcript는 보존된 경우**: 실제 활성 모델 컨텍스트는 줄었지만 UI가 archival transcript와 명시적 경계를 구분하지 못해 큰 값을 잘못 표시한다.

현재 wrapper는 압축 결과에서 이 두 경우를 판별하거나 기록하지 않는다. 따라서 UI만 보고 압축 성공을 확정할 수 없다.

#### 필요한 수정

이 문제는 문자열 기반 휴리스틱을 없애고 명시적인 압축 상태를 저장해야 해결된다.

1. 압축 시작 시 `compactionId`, 대상 `sessionId`, 압축 전 reported tokens를 기록한다.
2. 진행용 reasoning 메시지는 사용량 경계로 취급하지 않는다.
3. SDK가 실제 압축 성공을 확인할 수 있는 결과나 이벤트를 제공할 때만 경계를 확정한다.
4. 성공 경계를 로컬 임시 메시지가 아니라 persisted task/session metadata에 저장한다.
5. SDK 재수화 후에도 해당 metadata를 이용해 같은 경계를 복원한다.
6. 가능하면 압축 후 새 session ID를 만들고 `summary + recent turns`만 새 history로 구성한다.
7. 압축 직후 provider/SDK가 보고한 새 input token snapshot을 받아 사용량 기준점으로 저장한다.
8. archival transcript와 active model context를 별도 데이터로 다룬다. 화면에는 과거 대화를 계속 보여주더라도 사용량은 active context만 계산해야 한다.
9. 사용량 표시에 `reported`, `estimated`, `compaction pending`, `compaction verified` 상태를 명확히 표시한다.
10. 압축 완료 후 새 usage를 얻지 못하면 0으로 재설정하지 말고 "확인 중" 또는 "추정 불가"로 표시한다.

최소 수정으로는 `Compacting context... + assistant text`만으로 성공 경계를 만드는 로직을 제거해야 한다. 다만 이것만 적용하면 잘못된 0 리셋은 사라져도 실제 압축 기능은 개선되지 않는다. 올바른 해결은 SDK history를 실제로 축약하고, 그 성공 결과를 영속적인 compaction metadata 및 새 usage snapshot과 함께 전달하는 것이다.

### 필요한 수정

우선순위가 높은 수정은 다음과 같다.

1. 모델 호출 직전에 입력 토큰을 추정하고 한도보다 충분히 이른 시점에 압축한다.
2. 도구 결과를 transcript와 모델 컨텍스트에 넣기 전에 크기 제한, 구조적 요약, 파일 저장 후 참조 방식으로 축소한다.
3. context-length 계열 오류를 provider별 문자열/오류 코드로 식별한다.
4. 한도 오류가 발생하면 동일 세션 일반 재시도를 금지하고 복구 압축으로 전환한다.
5. 복구 압축은 최근 메시지와 중요 상태만 제한된 입력으로 구성하고 별도 세션 또는 별도 stateless 모델 호출에서 수행한다.
6. 요약이 성공하면 `요약 + 최근 N개 메시지 + 현재 작업 상태`로 새 세션을 만들고 기존 task ID와 연결한다.
7. 모델 호출조차 불가능하면 결정론적인 로컬 축약으로 최소 복구 컨텍스트를 만든다.
8. `AgentError`를 받은 실행은 후속 종료 이벤트에만 의존하지 말고 timeout 후 명시적으로 `failed` 처리한다.
9. 압축 성공 여부와 새 컨텍스트 토큰 수를 transcript와 interaction log에 기록한다.

## 2. interaction 로그 누적

### 현재 동작

VSIX host와 Node sidecar는 같은 날짜 파일에 JSONL 진단 정보를 기록한다.

```text
%LOCALAPPDATA%\VsClineAgent\logs\interaction-YYYYMMDD.jsonl
```

각 파일은 8 MiB에 도달하면 동일 날짜의 `.1` 파일로 한 번 회전한다. 그 날짜 안에서는 대략 현재 파일과 `.1` 파일이 유지되지만, 날짜가 바뀌면 새 파일이 생성된다.

### 문제

과거 날짜 파일을 삭제하는 로직이 없다. 따라서 verbose logging이 켜진 환경에서는 날짜마다 최대 약 16 MiB 수준의 파일이 계속 남을 수 있다. 기본 로그도 오류가 반복되면 장기간 누적된다.

또한 정리 스크립트는 `-ResetUserData`를 지정했을 때만 `logs`를 삭제한다. 정상 실행, 업데이트, 재설치 과정에서는 로그 보존기간을 관리하지 않는다.

### 권장 정책

- 기본 보존기간: 14일
- verbose 로그 보존기간: 3~7일
- 전체 로그 총량 상한: 100~250 MiB
- 시작 시와 새 날짜 파일 생성 시 오래된 파일 정리
- 수정시간이 오래된 순서로 삭제하되 현재 열린 파일은 제외
- 설정 화면에 현재 용량, 폴더 열기, 로그 삭제 버튼 제공
- 진단 번들 내보내기 시에만 필요한 기간을 ZIP으로 묶기

## 3. `settings.json` 및 대화 스냅샷 증가

`JsonStateStore`는 상태 전체를 JSON으로 저장하고 직전 파일을 `.bak`으로 복사한다. 저장 내용에는 다음이 포함된다.

- `taskHistory`
- `taskSnapshots`
- `currentTaskItem`
- `clineMessages`

`taskSnapshots`는 작업별 메시지 배열을 포함한다. 작업 수, 메시지 수, 개별 메시지 크기 또는 전체 파일 크기에 대한 보존 제한이 없다. 결과적으로 `settings.json`과 `.bak`이 함께 커져 실제 대화 데이터의 약 2배 공간을 사용할 수 있다.

권장 개선은 다음과 같다.

- 설정과 대화 데이터를 분리한다.
- 작업별 transcript를 별도 파일 또는 SQLite에 저장한다.
- 현재 작업만 메모리에 두고 과거 작업은 필요할 때 읽는다.
- 도구 원문, 대형 command output, browser result에는 개별 크기 제한을 적용한다.
- 오래된 비즐겨찾기 작업에 보존기간 또는 총량 상한을 적용한다.
- `.bak`은 작은 설정 메타데이터에만 사용하거나 압축한다.

## 4. Sidecar 폴더 증가

### 현재 구조

Sidecar 런타임은 다음 위치에 버전별로 준비된다.

```text
%LOCALAPPDATA%\VsClineAgent\Sidecar\<assembly-name-version>
```

각 버전 폴더에는 runtime JavaScript와 압축 해제된 `node_modules`가 들어간다. `node_modules`가 크기 대부분을 차지한다.

### 현재 정리 정책

`SidecarRuntimeInstaller`는 현재 버전을 제외한 디렉터리를 최근 수정시간 순서로 정렬한 뒤 2개를 보존한다. 즉 정상 상태에서도 다음이 허용된다.

```text
현재 버전 1개 + 과거 버전 2개 = 최대 3개 전체 런타임
```

런타임 하나가 수백 MiB라면 정상 정책만으로도 상당한 공간을 사용한다.

### 3개보다 더 쌓일 수 있는 이유

- 삭제 중인 폴더의 `node.exe` 또는 파일이 실행 중이라 Windows가 삭제를 거부한다.
- 바이러스 검사기, 인덱서, 백업 도구가 파일 핸들을 잡고 있다.
- 접근권한 또는 손상된 경로 때문에 재귀 삭제가 실패한다.
- 삭제 예외가 전부 무시되므로 사용자와 로그에 실패 사실이 나타나지 않는다.
- 17.0/17.12 패키지의 assembly name/version 조합이 달라 별도 캐시 세대를 만든다.
- `VSCLINE_SIDECAR_CACHE_KEY` 값이 자주 바뀌면 새 디렉터리가 계속 생긴다.

### 권장 개선

- 과거 런타임 보존을 기본 0~1개로 줄인다.
- 실행 중인 현재 경로만 제외하고 나머지는 종료 시 또는 다음 시작 시 재삭제한다.
- 삭제 실패를 interaction log에 경로, 크기, 예외와 함께 기록한다.
- 실패 폴더를 `pending-delete` 목록에 기록하고 다음 시작 때 재시도한다.
- 폴더 개수가 아니라 총량 상한도 적용한다.
- 동일한 `node_modules` fingerprint는 버전 간 공유하거나 content-addressed cache를 사용한다.
- 설치/업데이트 전에 오래된 sidecar 프로세스를 정상 종료하고, 제한시간 뒤 강제 종료 여부를 명확히 처리한다.

## 5. WebView2Data 폴더 증가

WebView2 브라우저 프로필은 다음 위치에 생성된다.

```text
%LOCALAPPDATA%\VsClineAgent\WebView2Data\<assembly-name-version>\<runtime-id>
```

`runtime-id`는 System Evergreen, Bundled Fixed 또는 Fixed Runtime 폴더 이름에서 만들어진다. 한 버전 안에서도 여러 runtime 후보로 초기화를 시도하면 프로필이 여러 개 생길 수 있다.

버전 정리 정책은 Sidecar와 동일하게 현재 외 과거 2개를 남긴다. 하지만 각 활성 프로필 내부에는 Chromium이 관리하는 다음 데이터가 계속 변한다.

- HTTP cache
- Code Cache
- GPUCache
- Service Worker 및 CacheStorage
- IndexedDB, Local Storage
- crash/diagnostic data

현재 애플리케이션 코드에는 이 내부 캐시의 보존기간이나 총량 제한이 없다. 실패한 초기화에서 특정 HRESULT가 발생했을 때만 해당 프로필을 통째로 지우고 한 번 재시도한다.

권장 개선은 다음과 같다.

- 앱 UI가 정적 로컬 리소스 중심이므로 종료 시 HTTP/Code/GPU cache 정리를 검토한다.
- WebView2 API의 browsing data 삭제 기능을 사용하되 로그인·설정에 필요한 Local Storage와 IndexedDB는 구분한다.
- 실패한 runtime 후보의 빈/부분 프로필을 즉시 제거한다.
- 프로필 버전을 assembly patch 버전과 묶지 않고 호환 가능한 schema version으로 관리한다.
- 시작 시 프로필 총량을 계산해 오래된 비활성 프로필을 지운다.
- 삭제 실패를 숨기지 않고 다음 시작 재시도 대상으로 기록한다.

## 6. WebView2Runtime 폴더 증가

로컬 Fixed Runtime 탐색 위치는 다음과 같다.

```text
%LOCALAPPDATA%\VsClineAgent\WebView2Runtime
```

`WebView2RuntimeResolver`는 이 디렉터리 또는 바로 아래 하위 디렉터리에서 첫 번째 공식 이름 형식의 Fixed Runtime을 찾는다. 이 경로에 여러 버전이 있어도 오래된 버전을 삭제하거나 가장 최신 버전을 고르는 정책이 없다.

즉 이 폴더는 프로그램이 매번 자동으로 복사해서 늘리는 경로라기보다, 설치·압축 해제·수동 배치 과정에서 추가된 Runtime이 정리되지 않는 경로다. Fixed Runtime 한 개 자체가 크므로 여러 버전이 있으면 사용량이 빠르게 증가한다.

또한 Fixed Runtime은 VSIX에도 포함될 수 있다.

```text
<Visual Studio extension install directory>\WebView2Runtime\...
```

따라서 같은 Runtime이 다음 위치에 중복될 수 있다.

1. VSIX 설치 디렉터리
2. `%LOCALAPPDATA%\VsClineAgent\WebView2Runtime`
3. 빌드 저장소의 `vendor\WebView2Runtime`
4. CAB 원본 및 임시 압축 해제 디렉터리

권장 개선은 다음과 같다.

- Evergreen 사용 가능 시 로컬 Fixed Runtime이 정말 필요한지 배포 정책을 명확히 한다.
- Fixed Runtime은 하나의 선택된 버전만 유지한다.
- 후보 선택 시 디렉터리 열거 순서가 아니라 파싱된 버전과 검증 결과를 사용한다.
- VSIX 번들 Runtime과 로컬 Runtime이 같으면 로컬 복제를 만들지 않는다.
- 설치/업데이트 도구에서 사용하지 않는 버전을 안전하게 제거한다.
- 빌드 스크립트의 `.webview2-fixed-extract` 임시 폴더는 성공·실패와 무관하게 `finally`에서 정리한다.

## 7. Markdown 표가 포함된 대화 복사 실패

### 관찰된 오류

대화 내용을 선택해 복사할 때 다음 WebApp 오류가 발생했다.

```text
unhandledrejection: Cannot handle unknown node `table`

Error: Cannot handle unknown node `table`
    at ...
    at Function.stringify (...)
```

진단 snapshot상 WebView와 Sidecar는 모두 정상 실행 중이었고 Sidecar 자체 오류도 없었다.

```text
WebView ready: True
Loaded: True
Sidecar running: True
Last sidecar error: (none)
```

따라서 이 오류는 Sidecar, 모델 provider 또는 MCP 호출 문제가 아니라 WebView의 클립보드 변환 단계에서 발생한 프런트엔드 예외다. 같은 로그에 있는 `mcp-office`의 `fetch failed` 경고는 시간상 별도의 문제이며 `table` node stringify 실패의 원인이 아니다.

### 재현 조건

다음 조건에서 재현될 수 있다.

1. assistant 메시지 등 대화 영역에 Markdown 표가 렌더링되어 HTML `<table>`이 존재한다.
2. 사용자가 코드 블록이 아닌 일반 대화 영역을 선택한다.
3. `Ctrl+C` 또는 copy 명령을 실행한다.
4. WebView copy handler가 선택 HTML을 Markdown으로 되돌리려고 한다.

표 전체가 아니라 선택 범위 안에 `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>` 구조가 일부 포함된 경우에도 같은 변환 경로로 들어갈 수 있다.

### 실제 코드 경로

`src/webview/src/components/chat/ChatView.tsx`는 document 전역에 비동기 `copy` 이벤트 핸들러를 등록한다. 선택 영역이 `pre/code` 같은 plain-text 우선 영역이 아니면 다음 순서로 처리한다.

```text
Selection Range
  → cloneContents()
  → 임시 div.innerHTML
  → convertHtmlToMarkdown(selectedHtml)
  → clipboardData 또는 FileService.copyToClipboard
```

`convertHtmlToMarkdown()`은 `markdownUtils.ts`에서 다음 unified pipeline을 사용한다.

```text
rehype-parse
  → rehype-remark
  → remark-stringify
```

HTML parser가 `<table>`을 HAST로 만들고 `rehype-remark`가 이를 MDAST의 GFM `table` node로 변환한다. 그러나 마지막 출력 단계에는 기본 `remark-stringify`만 등록되어 있다. 기본 Markdown에는 표 문법이 없기 때문에 `remark-stringify`의 `mdast-util-to-markdown`은 별도 GFM table handler 없이는 `table` node를 직렬화하지 못한다.

결국 다음 불일치가 직접 원인이다.

```text
입력/중간 AST: GFM table node 생성 가능
출력 serializer: GFM table node handler 미등록
결과: Cannot handle unknown node `table`
```

`remark-gfm`과 그 하위 의존성인 `mdast-util-gfm-table`은 이미 `src/webview/package.json` 및 lockfile에 설치되어 있다. 하지만 해당 HTML→Markdown 변환 pipeline에서는 import하거나 `.use(remarkGfm)`으로 등록하지 않는다. 즉 새 dependency가 없어서 생긴 문제가 아니라 기존 dependency를 변환 pipeline에 연결하지 않은 구성 오류다.

### `unhandledrejection`이 되는 이유

copy handler는 `async` 함수이지만 `convertHtmlToMarkdown()` 호출을 감싸는 `try/catch`가 없다.

```text
textToCopy = await convertHtmlToMarkdown(selectedHtml)
```

DOM의 `addEventListener("copy", asyncHandler)`는 반환된 Promise를 기다리거나 reject를 처리하지 않는다. 따라서 stringify 예외가 Promise rejection으로 빠져나가 전역 `unhandledrejection` 진단에 잡힌다.

예외가 clipboard 설정 전에 발생하므로 다음 동작도 실행되지 않는다.

- `e.clipboardData.setData("text/plain", textToCopy)`
- `FileServiceClient.copyToClipboard(...)`
- 명시적인 Markdown 복사 완료

브라우저 기본 copy가 우연히 동작할 여지는 있지만 handler의 비동기 시점과 WebView clipboard 정책에 따라 아무 내용도 복사되지 않거나 예상과 다른 HTML/plain text가 복사될 수 있다. 사용자 관점에서는 대화 복사 기능 전체가 실패한다.

### 영향 범위

- Markdown 표를 포함한 assistant 응답 복사
- 여러 메시지를 한 번에 선택할 때 그 안에 포함된 표
- tool 또는 MCP 결과가 표 형태로 렌더링된 영역
- 향후 GFM AST 확장 node를 생성하지만 stringify extension이 없는 다른 문법

화면 렌더링은 `remark-gfm`을 사용하는 별도 Markdown 렌더러에서 정상일 수 있다. 따라서 “표는 화면에 잘 보이지만 복사할 때만 실패”하는 비대칭이 생긴다.

### 권장 수정

첫 번째 수정은 변환 pipeline의 parse/transform/stringify 기능 집합을 일치시키는 것이다.

```ts
import remarkGfm from "remark-gfm"

const result = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, options)
    .process(html)
```

`remark-gfm`이 table, strikethrough, task list, autolink literal 등 GFM node와 serialization extension을 함께 등록하므로 현재 설치된 package 조합과도 맞는다.

두 번째로 copy handler에는 반드시 실패 fallback이 필요하다.

```text
HTML→Markdown 성공
  → Markdown을 clipboard에 기록

HTML→Markdown 실패
  → selection.toString() plain text를 clipboard에 기록
  → 진단 로그에 오류 종류만 기록
  → 전역 unhandledrejection 방지
```

복사는 보조 기능이므로 Markdown 변환이 실패해도 사용자가 선택한 원문 텍스트까지 잃게 해서는 안 된다. fallback도 실패할 때만 브라우저 기본 copy를 유지해야 한다.

### 필요한 테스트

현재 `convertHtmlToMarkdown`에 대한 직접 회귀 테스트가 없다. 최소한 다음 테스트가 필요하다.

1. `<table>`을 GFM pipe table로 변환한다.
2. `thead`가 없는 단순 table도 예외 없이 변환한다.
3. 셀 내부 emphasis, link, inline code를 보존한다.
4. 일부 행/셀만 선택한 불완전 HTML fragment도 복사 가능하다.
5. 변환기가 의도적으로 실패하면 `selection.toString()`으로 fallback한다.
6. copy handler 실행 후 `unhandledrejection`이 발생하지 않는다.
7. code block은 기존처럼 Markdown 재변환 없이 plain text로 복사한다.
8. 한국어와 긴 셀 내용, 줄바꿈이 있는 셀을 처리한다.

### 수정 우선순위

이 문제는 데이터 손상이나 프로세스 충돌을 일으키지는 않지만, 정상적으로 렌더링된 대화 결과를 외부로 가져갈 수 없게 만들고 전역 WebApp 오류 화면까지 유발한다. 재현이 단순하고 수정 범위가 작으므로 P1 사용자 기능 결함으로 처리하는 것이 적절하다.

## 8. 현재 제공되는 수동 정리 경로

저장소에는 다음 정리 스크립트가 있다.

```powershell
.\scripts\Clean-VsClineAgentInstall.ps1
```

기본 실행은 다음 런타임 캐시를 제거한다.

- `Sidecar`
- `WebView2Data`
- `WebView2Runtime`
- `changes`
- `home`
- `%TEMP%\VsClineAgent`

`-ResetUserData`를 추가하면 로그와 설정까지 삭제하므로 대화 기록과 사용자 설정을 잃을 수 있다. 분석 자료를 먼저 복사하지 않고 사용하면 안 된다.

수동으로 정리할 때는 반드시 Visual Studio와 관련 `node.exe`, `msedgewebview2.exe` 프로세스를 종료해야 한다. 실행 중 파일 잠금 때문에 삭제가 실패할 수 있다.

## 9. 안전한 용량 조사 명령

다음 PowerShell은 파일을 삭제하지 않고 하위 폴더별 크기를 계산한다.

```powershell
$root = Join-Path $env:LOCALAPPDATA "VsClineAgent"
Get-ChildItem -LiteralPath $root -Directory -Force | ForEach-Object {
    $bytes = (Get-ChildItem -LiteralPath $_.FullName -File -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    [pscustomobject]@{
        Folder = $_.FullName
        GiB = [math]::Round(($bytes / 1GB), 3)
        MiB = [math]::Round(($bytes / 1MB), 1)
    }
} | Sort-Object GiB -Descending
```

Sidecar 버전별 크기:

```powershell
$root = Join-Path $env:LOCALAPPDATA "VsClineAgent\Sidecar"
Get-ChildItem -LiteralPath $root -Directory -Force | ForEach-Object {
    $bytes = (Get-ChildItem -LiteralPath $_.FullName -File -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
    [pscustomobject]@{ Version = $_.Name; MiB = [math]::Round($bytes / 1MB, 1); Modified = $_.LastWriteTime }
} | Sort-Object Modified -Descending
```

WebView2 관련 디렉터리는 Visual Studio 확장 설치 경로에도 존재할 수 있으므로 `%LOCALAPPDATA%\Microsoft\VisualStudio\*\Extensions` 아래에서 `msedgewebview2.exe`와 `node_modules.zip`을 검색하면 중복 설치를 확인할 수 있다.

## 10. 구현 우선순위 제안

### P0: 기능 중단 방지

- context-length 오류 전용 복구 압축
- 대형 도구 결과의 모델 입력 전 제한
- `AgentError` 이후 확실한 terminal state 전환

### P1: 디스크 폭증 방지

- GFM table serializer 등록과 대화 복사 plain-text fallback
- 로그 보존기간과 총량 상한
- Sidecar 삭제 실패 기록 및 다음 시작 재시도
- WebView2Data 내부 캐시와 구버전 프로필 정리
- WebView2Runtime 단일 버전 정책

### P2: 저장 구조 개선

- `settings.json`에서 transcript 분리
- 작업별 지연 로딩 저장소 도입
- 진단/캐시 용량 UI와 안전한 정리 버튼
- Sidecar dependency content-addressed cache 또는 단일 공유 runtime

## 최종 판단

컨텍스트 한도 초과 후 동일 세션에 압축 프롬프트를 보내는 현재 방식은 실제 복구 수단이 될 수 없다. 사용자가 지적한 대로 압축이 가장 필요한 순간에 압축 자체가 실패하는 중대한 문제다.

디스크 사용량도 단순히 "로그가 많다"는 한 가지 문제가 아니다. 날짜별 로그 무기한 보존, 대화 스냅샷의 단일 JSON 누적, 대형 Sidecar 세대 보존, 삭제 실패 은폐, WebView2 프로필 내부 캐시, Fixed Runtime 중복이 합쳐진 결과다. 제품 수준의 해결에는 각 폴더별 보존 정책과 함께 `%LOCALAPPDATA%\VsClineAgent` 전체의 총량 예산이 필요하다.
