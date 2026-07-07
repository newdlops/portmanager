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

## 13. per-network 정체성 = 호스트명 가상화 (제네릭)

네트워크 격리는 연결(127.0.0.1/localhost→per-network loopback 재작성)까지는
투명하게 하지만, 프로세스는 여전히 자기가 "localhost"/머신 호스트명에 있다고
믿는다. 그래서 **호스트명 기반 정체성**(celery 기본 노드명 `@%h`, pidfile/log,
분산 락, 메트릭 태그 등)이 같은 디렉터리를 여러 네트워크에서 돌릴 때 겹친다.

**중요 원칙: extension은 셸(bash/sh/zsh)·프로세스 레벨만 다루고 앱(celery 등)을
몰라야 한다.** 그래서 정체성 구분은 앱-특화 로직이 아니라 **호스트명 가상화**로
제네릭하게 준다 — hook이 `gethostname()`/`uname()`을 인터포즈해, 네트워크 id를
가진 훅된 프로세스가 **그 네트워크의 루프백 주소(예: 127.93.164.7)를 호스트명으로
보게** 한다. 값이 네트워크 이름이 아니라 루프백 주소인 이유: 이름은 비ASCII/공백이
정제되며 퇴화·충돌할 수 있지만(`'알파 c'`→`-------c`) 루프백 주소는 구성상 유일하고
호스트명-안전하며 그대로 해석·접속된다. (루프백 env 부재 시에만 정제된 이름 폴백.)
그 셸과 모든 자식이 상속하므로, 호스트명으로 자기를 식별하는 아무 앱이나 자동으로
per-network 분리된다(예: celery `celery@%h`→`celery@127.93.164.7`). opt-in·fail-safe
(네트워크 없음/훅 off → 실제 호스트명 통과). zz-multi가 `--hostname=<cluster>`를
앱마다 손으로 박는 걸, PM은 syscall 층에서 투명하게 모든 앱에 제공하는 것.

- 전체 문서: **`docs/per-network-hostname.md`**
- hook: `pm_network_hostname` / `pm_gethostname_hook` / `pm_uname_hook` / 인터포즈 테이블 (`portmanager_hook.c`)
- 앱은 표준 호스트명 템플릿(`%h`/`%n`)을 쓰면 자동 분리. argv에 박힌 리터럴은 exec 경계에서
  훅이 **호스트 위치의 `localhost`만**(`@localhost`/`=localhost`/`://localhost`/`localhost:<포트>`)
  그 네트워크의 루프백으로 재작성한다 — 그래서 `celery multi … --hostname=localhost`도 무수정으로
  `celery1@127.x.y.z`가 된다. 단독 토큰 `localhost`(`grep localhost` 등)와
  `localhost.foo`/`mylocalhost`는 불변이고, 다이얼 용도는 어차피 connect() 재작성이 처리한다.
  opt-out: `PORT_MANAGER_ARGV_LOCALHOST_REWRITE=0`. 설정 **파일** 속 리터럴은 여전히 앱 몫.
  (`pm_rewrite_localhost_argv` — execve/posix_spawn/posix_spawnp 3지점 연결)

(폐기: 예전 파일시스템 경로 리다이렉션(`.portmanager/state-paths`, `pm_state_*`)은
celery-특화적이고 층이 틀려 되돌렸다. 정체성은 호스트명 층에서 제네릭하게 푼다.)

## 14. per-network env 값 = 생성자 주입 (`.portmanager/env/<네트워크이름>.env`)

라우팅은 하나의 .env로 모든 네트워크를 커버하고(로컬호스트 URL은 connect()에서
네트워크별 라우팅), 호스트명 가상화는 호스트명-파생 정체성을 가른다. 그러나
네트워크별로 **값 자체**가 달라야 하는 것(자격증명 경로, 버킷명 등)은 앱-특화 설정
없이 표현할 수 없었다. 제네릭한 공급 지점은 프로세스 시작 — hook dylib 생성자
(`pm_hook_loaded`)는 main()과 모든 런타임의 env 스냅샷(CPython os.environ/JVM/Go)보다
먼저 실행되므로, 여기서 setenv한 값은 어떤 런타임에도 보인다.

- 파일: cwd 상향 탐색(가까운 것 우선, 최대 64단계)으로
  `.portmanager/env/<네트워크이름>.env` (이름 없으면 network id 폴백; 이름은
  바이트 그대로 파일명, `/`→`-`).
- 우선순위: **네트워크 파일 > 터미널 상속 env > 앱의 .env** (dotenv 기본값이 기존
  변수를 안 덮으므로 자연 성립). overwrite 주입.
- 트리당 1회: `PORT_MANAGER_NETWORK_ENV_APPLIED=<network>` 마커로 자식은 상속만 —
  앱이 중간에 바꾼 값을 자식에서 되밟지 않는다. 셸은 unhooked라 마커가 없어 새
  명령마다 파일을 다시 읽는다(수정은 다음 실행부터 반영).
- 가드: `PORT_MANAGER_*`/`NEWDLOPS_PM_*`/`PATH`/`BASH_ENV`/preload 키는 파일에서
  절대 적용 안 됨. 네트워크 없음/훅 off → no-op.
- credential.json류(경로가 env로 전달되는 설정 파일)는 이 파일에서 경로 변수만
  네트워크별 값으로 주면 앱이 스스로 네트워크별 파일을 연다 — FS 가상화 불필요.
- 스캐폴드: 네트워크에 뭔가 붙을 때마다 — **윈도우 바인딩뿐 아니라 터미널 단위
  attach 스크립트 생성(`buildTerminalRoutingScriptBody`)에서도** — extension이
  워크스페이스 루트에 `env/<이름>.env`와 `files/<이름>/`를 자동 생성한다
  (`ensureNetworkEnvFileScaffold`, terminal-hook-environment.ts). 윈도우 바인딩
  경로 하나만 걸면 터미널-단위 attach 사용자는 영영 스캐폴드를 못 받는다(실제로
  겪은 버그). repo 루트의 `.env`가 있으면 `files/<이름>/.env`로 **자동 분할**
  (복사 시점엔 내용 동일 → 무해, 이후 네트워크별 독립). `.portmanager/`는
  머신-로컬이므로 **repo-local `.git/info/exclude`**에 넣는다(공유 .gitignore는
  건드리지 않음; 워크트리 `gitdir:` 추적, 손으로 쓴 `/.portmanager/` 변형도 중복
  없이 인식 — `ensureLocalGitExclude`). 기존 파일은 절대 덮지 않음. 훅은 이
  파일들을 **읽기만** 한다.
- 문서: **`docs/per-network-env.md`** / hook: `pm_apply_network_env_file` /
  `pm_network_env_apply_line` / `pm_find_network_env_file` (`portmanager_hook.c`).

## 15. per-network 파일 치환 (`.portmanager/files/<이름>/…`) — 대체 + 자동 상태 분할

규칙(사용자 명세): **`.portmanager`에 대응 파일이 존재하면 프로세스는 그 파일과만
소통하고 원본은 읽지 않는다** — 완전 대체, 쓰기 포함. 그리고 **`.pid`/`.lock`/log류
프로세스 상태 파일은 개입 없이 자동 분할**된다. root는 생성자에서 cwd 상향 탐색으로
1회 결정(`.portmanager` 디렉터리를 가진 가장 가까운 조상), per-open 비용 prefix 비교
+ stat 1회.

- 규칙 1(대체): 미러에 실존 파일이 있으면 `open/openat`이 그쪽을 연다(모든 모드).
- 규칙 2(자동 상태 분할): **진짜 신규**(원본 없음 또는 이미 우리 심링크 윈도우)
  O_CREAT가 **상태 관례**(닷-디렉터리 내부 / 닷파일 / `.pid .lock .log .sock .tmp
  .state` 접미)에 맞으면 미러에 생성(부모 자동 mkdir — 스캐폴드에 의존하지 않음,
  실제로 의존했다가 ENOENT 버그) + **원본 자리에 심링크 윈도우**를 남긴다 → unhooked
  관찰자(zz의 `tail -f`, exists 체크)도 내용을 본다. N개 네트워크면 윈도우는 마지막
  시작 네트워크를 가리키고, 각 네트워크의 훅 프로세스는 항상 자기 미러를 본다.
- 규칙 2b(읽기 스코핑): 상태 경로는 미러에 파일이 **없어도** 자기 미러로 해석한다
  (원본이 부재/윈도우일 때) — 읽기가 다른 네트워크의 윈도우를 타고 새지 않고 자기
  네임스페이스의 깨끗한 ENOENT를 받는다. unlink도 동일(남의 윈도우를 지우지 않음).
  이게 없으면 B가 A의 pidfile을 읽고 "이미 실행 중"으로 오판한다(실측한 누수).
- 규칙 1.5(dotenv copy-up): `.env`/`.env.*`는 **첫 접근 때 원본 바이트를 미러로
  복사(물질화)하고 그 뒤 모든 읽기·쓰기가 .portmanager 사본으로만** 간다 — 원본은
  다시는 읽히지도 쓰이지도 않는다. 네트워크마다 원본에서 독립적으로 copy-up.
- 규칙 3(관찰은 호출자의 네트워크): exec 경계 3지점의 세 번째 argv 패스
  (`pm_rewrite_state_path_argv`)가 **미러가 실존하는 파일을 가리키는 argv 토큰**
  (`--flag=경로` 형태 포함)을 미러 경로로 재작성한다. `tail`/`cat`은 PATH 심
  디렉터리의 트램펄린 별칭(`OBSERVATION_COMMAND_SHIM_NAMES`,
  terminal-hook-environment.ts)으로 hooked exec 경계를 얻으므로, unhooked SIP
  바이너리인데도 `tail -f .celery/celery.log`가 **그 터미널 네트워크의 미러**를
  팔로우한다 — 윈도우(마지막 시작 네트워크)가 아니라 각자 자기 것.
- 상태 관례 확장: 무확장자 파일(celerybeat-schedule류)과 `.db/.sqlite/.sqlite3`도
  자동 분할 대상. 반대로 **소스 확장자 신규 파일(.py/.ts 등)은 원본 위치 유지** —
  hooked `git checkout`/codegen이 미러 심링크가 아닌 실제 워크트리 파일을 만들어야
  해서(전면 리다이렉트 시 checkout이 깨진다).
- 절대 안 건드리는 것: 배경 인프라(`.git`/`node_modules`/`.venv`/`venv`/`__pycache__`),
  **기존 실파일**(yarn.lock 같은 커밋 파일은 제자리 갱신 유지; 기존 공유 `.celery/*`는
  한 번 지워야 윈도우가 형성됨), 일반 신규 파일(codegen 소스는 원본 위치).
- `unlink/unlinkat`도 같은 매핑(각 네트워크가 자기 pidfile만 정리; 다른 네트워크의
  윈도우는 보존). rename 미인터포즈 — 심링크 윈도우 덕에 대체로 무해(문서 참고).
- env 파일(§14)은 **오버레이**(값 주입), files는 **대체/분할** — 상보적.
  opt-out: `PORT_MANAGER_FILE_SUBSTITUTION=0`. intra-libc fopen(순수 C 앱) 우회
  가능(python/node/ruby 커버).
- 폐기했던 state-path 리다이렉션과의 차이: 설정 파일로 경로를 열거하지 않고(관례 +
  존재 기반), 심링크 윈도우로 unhooked 뷰 분열 문제를 풀었다(그때의 revert 사유).
- 문서: **`docs/per-network-files.md`** / hook: `pm_file_substitution_target` /
  `pm_file_substitution_relative_is_state` / `pm_file_substitution_symlink_back` /
  `pm_substitute_open(at)_hook` / `pm_substitute_unlink(at)_hook` (`portmanager_hook.c`).
