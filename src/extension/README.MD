# Extension

## 역할

VS Code 확장의 활성화 지점과 명령 등록을 담당한다.

## 책임

- 확장 activation과 dispose lifecycle 관리
- Port Manager 서비스 조립
- Command Palette 명령 등록과 레거시 명령 숨김
- Sidebar TreeDataProvider 등록
- Logical Network service 조립과 VS Code global state persistence
- Logical Network 생성 시 Linux namespace/Borrowed Network runtime 선택 조정
- 선택된 터미널에 network namespace attach 명령 또는 native hook 환경 주입
- VS Code 터미널 listen 실패 감지와 라우팅 재실행 제안은 legacy recovery path로 유지

## 주요 진입점

- `activate.ts`
- `commands.ts`
- `network-service.ts`
- `browser-dns-sync-coordinator.ts`: DNS full-table publication, duplicate coalescing, and bounded failure retries
- `terminal-hook-environment.ts`
- `terminal-conflict-monitor.ts`
- `terminal-secure-browser-link-provider.ts`
- `isolated-worktree-setup.ts`: Git worktree, Logical Network, Compose copy, 새 창 handoff를 묶는 retryable onboarding

## 외부 의존성

- VS Code Extension API
- `src/core`
- `src/platform`
- `src/ui`
- `src/config`

## 주의사항

이 모듈은 여러 계층을 조립할 수 있지만 도메인 판단 로직을 직접 구현하지 않는다.
DNS publisher는 registry 이벤트뿐 아니라 browser URL/proxy 갱신에서도 durable shared-state의 레코드·revision·경로를 함께 사용한다. 새 revision과 fence rejection 뒤의 최신 문서는 이전 실패의 backoff를 기다리지 않고 즉시 전송하며, 동일 revision의 실패는 계속 backoff한다. TCP browser listener 준비는 DNS push 완료를 기다리지 않는다. 두 경로를 직렬화하면 이미 정상 해석된 주소에서도 새 포트 연결이 늦어진다.
Browser route listener는 연결 첫 바이트로 HTTP/TLS/raw를 구분하므로 프로젝트 설정 파일로 프로토콜을 추측하지 않는다. 기존 route hint 파일 조회는 결과가 사용되지 않아 제거했고, 필요한 route shard와 managed-process 명령 조회는 동시에 수행한다. 공유 dev log의 `ts-browser-proxy` 항목으로 준비 시간과 bind 시간을 따로 확인할 수 있다.
Browser bind retry와 route-file watcher는 같은 proxy sync coalescer로 들어온다. 자동 재시도도 lease를 확인하고 최신 route/endpoint 상태로 준비한 뒤 owner 정보를 게시한다. 생성 route 파일 watcher는 browser owner만 유지하며, 내용이 같은 heartbeat와 관련 없는 파일을 걸러낸다. owner demotion/dispose에서 watcher와 retry를 함께 해제해 이전 창의 지연 작업이 새 창의 listener를 침범하지 않게 한다.
Browser target miss는 route와 fallback listener에 같은 갱신 snapshot을 사용한다. `LocalAgentClient.refresh`는 연결 세대별로 진행 중인 요청을 합치고, 실패 뒤 재시도와 stop/dispose 세대 무효화를 보장한다. command 분류는 고유 PID마다 조회하며 겹치는 sync도 진행 중인 조회를 공유한다. process id/startedAt/networkId 변경과 프로세스 소실은 이전 PID 결과의 적용을 막는다.
Logical Network 전환 기간에는 기존 라우팅 명령 구현을 유지하되 기본 UI와 Command Palette에서는 노출하지 않는다.
기본 activation은 새 Logical Network service를 시작하며, 레거시 agent/hook/terminal failure monitor는 자동 시작하지 않는다.
VS Code 새 터미널의 정적 라우팅 context는 process creation에서 복사하고, native preload·runtime shim PATH·BASH_ENV·활성화 플래그만 사용자 shell profile 이후 shell integration에서 주입한다. 외부 터미널용 profile 설치도 managed prelude/postlude로 사용자 NVM·asdf·pyenv 초기화 구간에서는 상속된 PM preload와 PATH shim을 builtin-only로 잠시 내리고, profile이 끝난 뒤 같은 네트워크 context로 복구한다. `Restore Shell Profiles`는 이 exact managed block과 legacy source 줄만 제거하며 사용자 profile 본문과 생성 자산은 보존한다. shell integration이 동작하지 않는 터미널은 자동 주입하지 않으며, 이 경우 명시적 terminal attach 스크립트를 사용한다. attach 스크립트는 Compose 함수 본문을 eager parse하지 않고 Docker/Podman PATH shim이 실제 runtime 호출 시 로드한다.
`Open Network Terminal`은 선택한 네트워크의 동일 attach 스크립트를 새 VS Code 통합 터미널의 첫 입력으로 queue한다. 스크립트 생성과 runtime 검증을 터미널 생성보다 먼저 수행하며, window-wide 기본 네트워크 binding은 변경하지 않는다.
`escapedServerRespawn`이 꺼진 기본 경로에서는 native hook의 control-channel thread/socket을 만들지 않는다. 이 채널은 destructive respawn 기능 전용이며, 일반 prompt helper의 spawn 경로에 들어가면 안 된다.
Logical Network는 터미널 bind 포트를 호스트 namespace에서 직접 점유하지 않게 만드는 runtime이 있을 때만 생성/attach해야 한다. `Local TCP Proxy`는 host exposure 보조 기능일 뿐 터미널 포트 namespace를 분리하지 않는다.
Linux Docker/Podman runtime이 감지되면 `src/platform/network` adapter가 전역 bridge network와 logical network별 namespace holder container를 관리한다. macOS에서는 Docker Desktop network namespace를 host 터미널에 직접 빌릴 수 없으므로 Native Socket Hook runtime을 Borrowed Network 구현으로 사용한다. Native Socket Hook은 컨테이너를 만들지 않고 선택된 shell에 hook 환경을 주입하므로, attach 이후 시작한 프로세스에만 적용된다.
