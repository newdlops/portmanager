# Port Manager 구현 지침

이 문서는 Port Manager VS Code Extension을 구현할 때 지켜야 하는 프로젝트 지침이다. 모든 코드 변경은 `SPEC.MD`의 제품 스펙과 이 문서의 구현 원칙을 함께 따른다.

## 1. 기본 원칙

- 모든 모듈은 재사용성과 확장성을 고려해 설계한다.
- 모듈은 단일 책임을 갖도록 나누되, 과도한 분리는 피한다.
- 구현은 읽는 사람이 시스템의 의도를 빠르게 파악할 수 있는 구조를 우선한다.
- 특정 프레임워크, 플랫폼, 명령어에 강하게 묶이는 코드는 인터페이스 뒤에 둔다.
- 기능 추가 시 기존 구조를 우선 활용하고, 새 추상화는 실제 중복 또는 복잡도를 줄일 때만 도입한다.

## 2. 추상화 기준

- 추상화는 구현 세부사항을 숨기고 도메인 개념을 드러내기 위해 사용한다.
- 포트 탐색, 프로세스 실행, 프로세스 레지스트리, VS Code UI, 플랫폼별 명령 실행은 서로 다른 책임으로 분리한다.
- 인터페이스는 호출자가 알아야 하는 동작만 드러낸다.
- 구현체 이름은 기술적 세부사항을 포함해도 되지만, public API 이름은 도메인 용어를 우선한다.
- 추상화가 호출 흐름을 더 어렵게 만들면 도입하지 않는다.

## 3. 로직 영역과 로우레벨 영역 분리

로직 영역은 Port Manager의 정책과 판단을 담당한다.

- 요청 포트와 실제 포트 매핑 결정
- 인접 포트 탐색 정책
- 프로세스 상태 전이
- 사용자 설정 해석
- 라우팅 실패 처리

로우레벨 영역은 외부 시스템과 직접 접촉하는 구현을 담당한다.

- `child_process` 실행
- `lsof`, `netstat`, `ss`, PowerShell 같은 플랫폼 명령 호출
- VS Code API 호출
- 파일 시스템 접근
- 브라우저 열기

로직 영역은 로우레벨 구현을 직접 호출하지 않고, 인터페이스를 통해 의존한다.

## 4. 파일 길이 기준

- 소스 파일은 원칙적으로 500줄 이상 1000줄 이하를 유지한다.
- 1000줄을 넘는 파일은 책임 분리를 검토한다.
- 500줄보다 짧은 파일이 생길 경우, 지나치게 잘게 나눈 구조인지 검토한다.
- 단, 설정 파일, 타입 선언 파일, 테스트 fixture, 생성 파일, `index.ts` 같은 단순 re-export 파일은 예외로 둘 수 있다.
- Markdown 문서는 줄 수 제한을 두지 않는다.

## 5. 디자인 패턴 사용 기준

- 디자인 패턴은 문제를 명확하게 만들 때만 사용한다.
- 과도한 패턴 적용으로 호출 흐름이 복잡해지면 사용하지 않는다.
- 이 프로젝트에서 우선 고려할 수 있는 패턴은 다음과 같다.
  - Strategy: 포트 탐색 정책, 플랫폼별 포트 조회 방식
  - Adapter: VS Code API, 플랫폼 명령, child process 실행 래핑
  - Repository: 관리 중인 프로세스 상태 저장소
  - Observer/Event Emitter: 프로세스 상태 변경과 UI 갱신
  - Factory: 실행 프로필 또는 플랫폼별 구현체 생성

## 6. 주석 작성 기준

- 함수, 파일, 클래스에는 메커니즘을 설명하는 주석을 단다.
- 주석은 코드가 무엇을 하는지 반복하지 않고, 왜 그렇게 동작하는지와 어떤 흐름으로 동작하는지를 설명한다.
- 복잡한 조건문, 상태 전이, 플랫폼별 분기, 오류 복구 로직에는 짧은 설명을 남긴다.
- public API와 도메인 모델에는 사용 의도와 불변 조건을 설명한다.
- 임시 해결책에는 이유와 제거 조건을 함께 적는다.

예시:

```ts
/**
 * 요청 포트가 점유된 경우 설정된 탐색 정책에 따라 실제 실행 포트를 결정한다.
 * 이 클래스는 포트 점유 확인 방법을 알지 못하고 PortAvailability 인터페이스에 위임한다.
 */
export class PortRoutingService {}
```

## 7. 중요 변수 주석 기준

- 상태 전이, 포트 매핑, 플랫폼별 실행 결과처럼 의미가 중요한 변수에는 역할을 설명하는 주석을 단다.
- 변수명만으로 의미가 명확한 단순 지역 변수에는 주석을 강제하지 않는다.
- 오래 유지되는 필드, 설정값, 캐시, 이벤트 핸들러 목록에는 역할과 생명주기를 설명한다.

예시:

```ts
// 사용자가 요청한 논리 포트다. 충돌이 발생해도 이 값은 변경하지 않는다.
const requestedPort = 3000;

// 실제 프로세스에 주입할 포트다. 충돌 시 인접 가용 포트로 대체된다.
const actualPort = 3001;
```

## 8. 모듈 README 기준

- 각 모듈의 진입점 폴더에는 `README.MD`를 만든다.
- `README.MD`에는 해당 모듈의 역할, 책임, 외부 의존성, 주요 진입점을 적는다.
- 모듈 README는 구현 상세보다 모듈을 이해하는 데 필요한 경계를 설명한다.
- 새 모듈을 추가할 때는 코드와 README를 함께 추가한다.

기본 형식:

```md
# Module Name

## 역할

## 책임

## 주요 진입점

## 외부 의존성

## 주의사항
```

## 9. 권장 폴더 구조

초기 구현은 다음 구조를 기준으로 한다.

```text
src/
  extension/
    README.MD
    activate.ts
    commands.ts
  core/
    README.MD
    ports/
    processes/
    routing/
  platform/
    README.MD
    process/
    ports/
    vscode/
  ui/
    README.MD
    sidebar/
  config/
    README.MD
  shared/
    README.MD
    errors/
    events/
    types/
test/
  unit/
  integration/
media/
  README.MD
```

폴더 책임은 다음과 같다.

- `src/extension`: VS Code extension activation, command registration, contribution 연결
- `src/core`: 포트 라우팅과 프로세스 관리의 순수 도메인 로직
- `src/platform`: 운영체제, Node.js, VS Code API 같은 로우레벨 어댑터
- `src/ui`: 사이드 패널과 사용자 인터페이스 구성
- `src/config`: 사용자 설정 로드, 검증, 기본값 관리
- `src/shared`: 공통 타입, 에러, 이벤트 유틸리티
- `test/unit`: 순수 로직과 어댑터 단위 테스트
- `test/integration`: VS Code extension 통합 동작 테스트
- `media`: webview, 아이콘, 정적 리소스

## 10. 의존성 방향

의존성은 아래 방향을 따른다.

```text
extension -> ui -> core
extension -> platform
ui -> core
core -> shared
platform -> shared
config -> shared
```

금지되는 의존성:

- `core`가 `vscode` API를 직접 import하는 것
- `core`가 `child_process`를 직접 import하는 것
- `ui`가 플랫폼 명령을 직접 실행하는 것
- `platform`이 UI 상태를 직접 변경하는 것

## 11. 구현 체크리스트

새 기능을 구현할 때는 다음을 확인한다.

- 책임이 적절한 모듈에 위치하는가
- 로직과 로우레벨 구현이 분리되어 있는가
- 재사용 가능한 정책 또는 어댑터로 표현할 부분이 있는가
- 주석이 메커니즘과 중요한 변수의 역할을 설명하는가
- 새 모듈 폴더에 `README.MD`가 있는가
- 파일 길이 기준을 지키거나 예외 사유가 명확한가
- 테스트가 로직, 플랫폼 어댑터, UI 동작의 위험도에 맞게 추가되었는가

## 12. 개발용 로그 엔드포인트 (디버깅)

라우팅/attribution 동작을 추적할 때는 **리빌드 없이** 켤 수 있는 공유 dev-log
엔드포인트를 사용한다. `portManager.developmentLogPath` 설정(또는
`PORT_MANAGER_DEV_LOG` 환경변수)에 절대경로를 지정하고 창을 리로드하면, 네이티브
hook/router/agent와 확장 호스트가 **하나의 파일**에 attribution·라우팅 결정을
추가한다. 비워두면 무비용 no-op이다.

- 사용법·형식·구성요소별 로그·확장 방법: **`docs/dev-logging.md`**
- 네이티브 로거: `native/shared/pm_dev_log.{h,c}` / TS 로거: `src/platform/dev-log.ts`
- 새 native 바이너리에 로그를 추가하려면 헤더를 include하고 `pm_dev_log(...)`를
  호출한 뒤 `scripts/build-native-hook.sh`의 컴파일 라인에 `pm_dev_log.c`를 추가한다.

새 로우레벨 진단 코드를 임시 `fprintf`/`appendFileSync`로 심지 말고 이 엔드포인트를
쓴다 (다음 세션에서도 동일하게 켜고 끌 수 있도록).

## 13. per-network 로컬 상태 격리 (파일시스템 축)

네트워크 격리는 L4(포트/루프백) 축이다. 같은 작업 디렉터리를 여러 네트워크에
attach하면 앱의 **로컬 상태 파일**(celery pidfile/logfile, 소켓, sqlite 등)이
같은 디스크 경로라 충돌한다 — 이건 네트워크 격리가 못 건드리는 파일시스템 축이다.

hook이 경로-계열 libc 호출(`open/openat/stat/lstat/access/unlink/rename/mkdir`)을
인터포즈해, 네트워크 id를 가진 훅된 프로세스가 **설정된 상태 루트** 아래 경로를
열면 `<root>/__pmnet__/<network>/…`로 투명 재작성한다(비매칭은 바이트 동일 통과,
opt-in, fail-safe). 설정 `.portmanager/state-paths`(레포에 커밋 → 모든 워크트리
공통)는 **hook이 프로세스 cwd에서 상향 탐색으로 직접 찾아 읽는다** — 에디터
workspace 폴더에 의존하지 않으므로 프로세스가 실제 도는 repo에 정확히 묶인다.

- 전체 문서: **`docs/per-network-state.md`**
- hook: `pm_state_init`(cwd 상향 탐색) / `pm_state_redirect_path` / `pm_*_hook` / 인터포즈 테이블 (`portmanager_hook.c`)

앱이 하드코딩한 로컬 상태 경로(pidfile 등) 때문에 다중 네트워크 인스턴스가 깨지면
앱을 고치지 말고 `.portmanager/state-paths`에 그 경로를 선언한다 (제네릭 격리 원칙).
