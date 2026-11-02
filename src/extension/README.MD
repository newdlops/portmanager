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
- 기존 호스트 셸의 `pm` 메뉴·네트워크 전환·터미널 제목을 유지
- VS Code 터미널 listen 실패 감지와 라우팅 재실행 제안은 legacy recovery path로 유지

## 주요 진입점

- `activate.ts`
- `commands.ts`
- `network-service.ts`
- `browser-dns-sync-coordinator.ts`: DNS full-table publication, duplicate coalescing, and bounded failure retries
- `terminal-hook-environment.ts`
- `legacy-settings-notices.ts`: attach와 설정 명령의 비활성 legacy 경로 알림·변경 시 재알림. filesystem scaffold의 metadata 결과만 받아 원본 파일은 변경하지 않는다. 짧은 파일은 OS 어댑터와 VS Code 알림 경계를 분리하기 위한 것이다.
- `terminal-conflict-monitor.ts`
- `terminal-secure-browser-link-provider.ts`
- `isolated-worktree-setup.ts`: Git worktree, Logical Network, Compose copy, 새 창 handoff를 묶는 retryable onboarding
- `uv-run-preload-repair.ts`: hardened `uv` 가 지운 preload 를 `uv run` 이 실행하는 명령에서 복구하는 uv shim 단계

## 외부 의존성

- VS Code Extension API
- `src/core`
- `src/platform`
- `src/ui`
- `src/config`

## 주의사항

설정 열기 명령은 owner lease나 terminal attach 없이 선택한 network ID의 폴더를 연다. 복수 workspace는 경로를 보여 주고 먼저 선택하며 취소하면 파일을 만들지 않는다. legacy 알림은 nonmodal이고 같은 source/metadata는 창 안에서 중복하지 않는다. 변경된 원본은 다음 attach에서 다시 알리며 현재 설정에 자동 병합하지 않는다.

확장 호스트가 새로 시작한 뒤 첫 daemon convergence는 현재 daemon에 이미 연결되어 있어도 listener 재탐색과 route 파일 게시를 한 번 완료한 뒤 해당 복구 패스의 후속 작업을 진행한다. 초기 DNS 전송이 먼저 연결한 경우 metadata와 빈 초기 snapshot만으로 복구 완료를 판단하지 않는다. 연결·교체 단계나 명시적 파일 복구가 이미 게시를 완료했다면 재탐색을 중복하지 않으며, 실패한 첫 복구는 다음 자동 convergence에서 다시 시도한다. 이후 정상 background 갱신에는 추가 전체 탐색을 넣지 않는다. 별도 이벤트에서 수행하는 DNS·proxy 갱신은 기존의 독립 경로를 유지한다.

이 모듈은 여러 계층을 조립할 수 있지만 도메인 판단 로직을 직접 구현하지 않는다.
macOS 기본 실행은 사용자 호스트 셸에 협조적 native hook을 주입한다. 커널 보호 셸 시제품은 기본 profile·`pm`·attach에 연결하지 않는다. 이전 버전이 지정한 `Port Manager: Logical Network` 기본 profile만 저장된 사용자 값으로 복구하며, 이후 사용자가 고른 다른 profile은 보존한다. XDG cache/data/state와 TMPDIR을 덮어쓰지 않는다.
일반 터미널 스크립트 생성은 기존 Compose projection을 재사용하고 강제 Docker 조회를 기다리지 않는다. 실제 attach·명시적 복구와 owner 갱신은 기존 reconciliation을 유지한다. `Start Daemon`은 singleton client의 시작 직렬화를 사용하고 전체 owner startup을 기다리지 않는다. 재시작·종료의 owner 확인은 유지한다.
hardened runtime 으로 서명되고 DYLD 환경변수 권한이 없는 패키지 매니저(공식 설치본 `uv`)는 dyld 가 preload 를 무시하고 환경에서도 지우므로, 그 자식 서버가 훅 없이 실제 `127.0.0.1` 에 bind 한다. uv shim 은 그런 uv 의 `uv run <명령>`·`-m <모듈>`·`<스크립트>.py` 앞에 native hook 의 `sh -c` 복구 구문(`PM_SH_C_PREAMBLE`, 테스트로 동일성 고정)을 끼워 명령 쪽에서 preload 를 되살린다. 인자 해석은 builtin 만 쓰고 `uv run` 일 때만 codesign 으로 서명을 확인하며, 위치가 확실하지 않은 형태는 그대로 넘기고 한 줄 안내만 남긴다.
Docker/Podman 컨테이너 이름 치환은 명령별로 컨테이너를 가리키는 인자 자리에만 한다(`compose-project-routing.ts` 셸 wrapper 와 native docker shim 이 같은 문법표를 쓰고 테스트가 둘을 비교). 옵션 값이나 `exec` 가 컨테이너 안에서 돌리는 명령은 이름과 같아도 바꾸지 않고, 짧은 해시 접두 일치는 양쪽이 16진 id 일 때만 쓴다.
package-bin 셸 래퍼와 native runtime resolver는 stamp metadata로 모든 PM shim 세대를 건너뛴다. 셸 래퍼는 PATH마다 `cd`/`pwd`·`sed` 프로세스를 만들지 않고 builtin으로 헤더를 확인한다. native resolver는 실제 실행 파일의 논리 경로를 보존해 `.venv/bin/python`의 가상환경과 설치된 모듈을 유지한다.
DNS publisher는 registry 이벤트뿐 아니라 browser URL/proxy 갱신에서도 durable shared-state의 레코드·revision·경로를 함께 사용한다. 새 revision과 fence rejection 뒤의 최신 문서는 이전 실패의 backoff를 기다리지 않고 즉시 전송하며, 동일 revision의 실패는 계속 backoff한다. TCP browser listener 준비는 DNS push 완료를 기다리지 않는다. 두 경로를 직렬화하면 이미 정상 해석된 주소에서도 새 포트 연결이 늦어진다.

DNS 전송·확인은 PID와 startedAt으로 daemon 수명을 구분한다. 전송 시점의 정체성을 결과와 오류에 유지하여 이전 daemon의 응답이 현재 확인/진단을 바꾸지 못하게 한다. 새 수명이나 더 최신의 responder-down heartbeat는 같은 revision도 다시 게시하며, 정상 heartbeat의 시간만 바뀌면 중복 게시하지 않는다. 동일 수명·revision의 진행 중 요청은 하나로 합치고 dispose 뒤에는 결과·오류 콜백을 실행하지 않는다. 명시적으로 정지한 client는 DNS 경로에서 local suspended 결과를 반환하여 background retry가 daemon을 되살리지 않게 하며, 명시적 start/restart의 status 이벤트가 현재 레코드를 다시 게시한다. 이 표식은 IPC payload가 아닌 client 내부 결과다.

client는 DNS 응답의 running/port/error도 현재 관측 상태에 반영한다. healthy heartbeat 없이 bind 성공 뒤 다시 실패하더라도 다음 down heartbeat가 기존 down snapshot과 같다고 누락되지 않도록 하기 위함이다. 명시적인 client 관측 health는 RPC 완료 시각보다 우선한다. native heartbeat는 초 단위이므로 같은 초에 도착한 실패를 밀리초 RPC 시각과 비교하면 실패가 가려질 수 있다. health가 없는 구형 snapshot에만 동일 daemon 수명의 RPC 결과를 fallback으로 사용한다. 응답 대기 중 연결 generation·PID·startedAt이 바뀌거나 stop/dispose되면 이 관측 갱신은 버린다.
Browser route listener는 연결 첫 바이트로 HTTP/TLS/raw를 구분하므로 프로젝트 설정 파일로 프로토콜을 추측하지 않는다. 기존 route hint 파일 조회는 결과가 사용되지 않아 제거했고, 필요한 route shard와 managed-process 명령 조회는 동시에 수행한다. 공유 dev log의 `ts-browser-proxy` 항목으로 준비 시간과 bind 시간을 따로 확인할 수 있다.
Browser bind retry와 route-file watcher는 같은 proxy sync coalescer로 들어온다. 자동 재시도도 lease를 확인하고 최신 route/endpoint 상태로 준비한 뒤 owner 정보를 게시한다. 생성 route 파일 watcher는 browser owner만 유지하며, 내용이 같은 heartbeat와 관련 없는 파일을 걸러낸다. owner demotion/dispose에서 watcher와 retry를 함께 해제해 이전 창의 지연 작업이 새 창의 listener를 침범하지 않게 한다.
Browser target miss는 route와 fallback listener에 같은 갱신 snapshot을 사용한다. `LocalAgentClient.refresh`는 연결 세대별로 진행 중인 요청을 합치고, 실패 뒤 재시도와 stop/dispose 세대 무효화를 보장한다. command 분류는 고유 PID마다 조회하며 겹치는 sync도 진행 중인 조회를 공유한다. process id/startedAt/networkId 변경과 프로세스 소실은 이전 PID 결과의 적용을 막는다.
Docker 정기 탐색은 정상 이벤트 스트림이 모든 사용 runtime을 커버할 때 5분 간격의 누락 복구용 조회만 수행한다. 스트림이 없거나 Docker/Podman 혼용으로 일부 runtime이 커버되지 않으면 1분 간격을 유지한다. 후보 목록과 Compose route reconciliation은 하나의 공유 refresh slot과 세션 map을 사용하고, `auto`로 선택된 Docker/Podman 세션도 해당 runtime의 명시적 조회에 재사용한다. 프로젝트 이벤트의 갱신 시각은 전체 복구 타이머를 미루지 않는다. 사이드바를 다시 열거나 명시적으로 refresh하면 즉시 새로 읽는다. 이벤트의 Compose label 또는 알려진 container ID로 관련 네트워크만 override를 강제 재검증하며, 정체성을 확인할 수 없으면 해당 runtime 전체를 복구한다. 숨겨진 뷰에서 관련 없는 프로젝트 이벤트는 Docker 조회를 만들지 않는다. UI 소비자가 없어도 daemon에 남은 orphan Compose route 정리는 유지한다.
공유 상태 변경은 Compose row를 ID로 비교하여 실제로 추가·변경·삭제된 네트워크만 강제 검증한다. 터미널 연결 변경이나 JSON 순서 차이는 Docker 복구를 유발하지 않는다. document 적용은 즉시 진행하고 후속 파일·runtime 작업만 단일 큐로 합쳐 느린 Compose 조회가 DNS 상태 전파를 막지 않게 한다. 이미 강제 검증한 override는 TSV 배포에서 재사용하되 누락 파일 복구는 유지한다. 실패한 범위는 다음 상태 변경 또는 background tick에서 재시도하며, owner가 바뀌면 대기 중인 작업을 버린다.
Logical Network 전환 기간에는 기존 라우팅 명령 구현을 유지하되 기본 UI와 Command Palette에서는 노출하지 않는다.
기본 activation은 새 Logical Network service를 시작하며, 레거시 agent/hook/terminal failure monitor는 자동 시작하지 않는다.
VS Code 새 터미널의 정적 라우팅 context는 process creation에서 복사하고, native preload·runtime shim PATH·BASH_ENV·활성화 플래그만 사용자 shell profile 이후 shell integration에서 주입한다. 외부 터미널용 profile 설치도 managed prelude/postlude로 사용자 NVM·asdf·pyenv 초기화 구간에서는 상속된 PM preload와 PATH shim을 builtin-only로 잠시 내리고, profile이 끝난 뒤 같은 네트워크 context로 복구한다. `Restore Shell Profiles`는 이 exact managed block과 legacy source 줄만 제거하며 사용자 profile 본문과 생성 자산은 보존한다. shell integration이 동작하지 않는 터미널은 자동 주입하지 않으며, 이 경우 명시적 terminal attach 스크립트를 사용한다. attach 스크립트는 Compose 함수 본문을 eager parse하지 않고 Docker/Podman PATH shim이 실제 runtime 호출 시 로드한다.
`Open Network Terminal`은 선택한 네트워크의 동일 attach 스크립트를 새 VS Code 통합 터미널의 첫 입력으로 queue한다. 스크립트 생성과 runtime 검증을 터미널 생성보다 먼저 수행하며, window-wide 기본 네트워크 binding은 변경하지 않는다.
`escapedServerRespawn`이 꺼진 기본 경로에서는 native hook의 control-channel thread/socket을 만들지 않는다. 이 채널은 destructive respawn 기능 전용이며, 일반 prompt helper의 spawn 경로에 들어가면 안 된다.
Logical Network는 터미널 bind 포트를 호스트 namespace에서 직접 점유하지 않게 만드는 runtime이 있을 때만 생성/attach해야 한다. `Local TCP Proxy`는 host exposure 보조 기능일 뿐 터미널 포트 namespace를 분리하지 않는다.
Linux Docker/Podman runtime이 감지되면 `src/platform/network` adapter가 전역 bridge network와 logical network별 namespace holder container를 관리한다. macOS에서는 Docker Desktop network namespace를 host 터미널에 직접 빌릴 수 없으므로 Native Socket Hook runtime을 Borrowed Network 구현으로 사용한다. Native Socket Hook은 컨테이너를 만들지 않고 선택된 shell에 hook 환경을 주입하므로, attach 이후 시작한 프로세스에만 적용된다.
