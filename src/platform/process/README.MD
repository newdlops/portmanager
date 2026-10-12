# Platform Process

## 역할

관리형 프로세스를 실제 OS child process로 실행하고 종료한다.

## 책임

- 실행 명령 시작
- 실제 포트를 환경 변수와 템플릿에 주입
- PID와 종료 이벤트 추적
- 설정된 종료 신호 전달
- OS process table에서 터미널 후보 탐색
- OS process table에서 PID, PPID, PGID, TTY 관계 조회
- OS process environment에서 Port Manager logical network scope 조회
- native helper를 통한 PID ancestry, cwd, routing network 조회와 기존 명령 기반 fallback 유지
- Mach-O/ELF header와 native agent argument-parser probe로 현재 CPU/OS loader 호환성 검증
- routing disabled 상태에서 hook dylib/so를 agent에 실제 preload해 동적 로더 호환성 검증
- hook 라이브러리를 `~/.portmanager/runtime/<OS>-<CPU>/media/native/`의 고정 경로에 원자적으로 복사하여 확장 업데이트 뒤에도 기존 launcher의 preload 경로 유지
- 변경 없는 hook 재게시 확인은 source/target의 inode·size·mtime·ctime으로 전체 binary 재읽기를 생략한다. 최대 8개 metadata만 보관하며 손상·교체·symlink는 byte 검증과 원자적 복사로 복구한다.
- 설치된 shell script를 `sh -n`으로 검사하고 실제 source 후 `pm` 함수 및 profile marker 유지 검증
- ID 기반 네트워크 파일 scaffold와 소유자가 명확한 legacy 설정의 비파괴 마이그레이션
- UI가 터미널 창/세션으로 그룹화할 수 있는 tty, process group, console 식별자 제공

## 주요 진입점

- 보호된 zsh의 `ZDOTDIR` bootstrap과 macOS `.zsh_sessions`는 해당 네트워크의
  workspace namespace 아래에 둔다. `.zshenv`에서 per-network `HISTFILE`을 먼저
  지정해 시스템 zshrc가 기록을 초기화할 때도 공유 호스트 history를 쓰지 않는다.
  broker/launcher/hook과 controller credentials는 기존 보호 경로에 유지한다.

- `shell-profile.ts`: PM이 소유한 shell profile 경계의 설치·마이그레이션·복구
- `node-process-launcher.ts`
- `node-runtime.ts`
- `node-process-table.ts`
- `node-process-environment.ts`
- `native-process-lookup.ts`: `identity <pid>`는 전체 표·env 조회 없이 OS PID/birth를 읽는다. 기존 inspect/capture의 env networkId는 보안 권한을 대신하지 않음
- `native-executable.ts`: native parser probe의 순수 timeout만 같은 1초 한도로 한 번
  재확인한다. 두 번째도 실패하거나 loader·권한·exit 계약 오류가 있으면 실패로 유지한다.
- `network-file-scaffold.ts`: 0700 디렉터리, 0600 파일, 원자적 미교체 게시 및 symlink 거부
- `network-terminal-control.ts` / `network-terminal-client.ts`: 비활성 커널 보호 셸 시제품의 private host-side terminal launch와 controller-driven replacement. 기본 `pm`·attach에서는 사용하지 않는다. key와 control FD는 guarded child에 전달하지 않는다.
  `pm` 메뉴의 번호·이름 선택과 유지보수 명령은 호스트의 입력에서 읽는다. namespace의
  고정 표식은 UI 열기만 요청하고 내용은 실행하지 않는다. 취소·잘못된 선택·준비 실패는
  현재 셸을 유지하며, 메뉴 입력 handle은 CLI 종료 시 함께 닫는다.
  실제 TTY는 기존 supervisor의 private foreground acknowledgement를 확인한 뒤
  입력하고 완료 후 보호 셸에 반환한다. 별도 native helper를 시작하지 않는다.
- `macos-network-runtime.ts`: 비활성 커널 보호 셸 시제품의 protected artifact/profile publication, fixed-id broker ownership, trusted readiness와 shared native reservations. PTY/UI는 extension adapter가 담당한다.
  namespace bootstrap은 네트워크 제목, `pm` 도움말·상태·버전·진단·route 목록을 제공한다.
  직접 VS Code profile은 메뉴 요청을 trusted Quick Pick으로 전달한다. 진단용 route 파일은
  해당 네트워크의 승인된 목적지만 포함하고 broker policy 갱신과 함께 바뀐다.
  사용자 HOME, XDG 저장소·캐시와 TMPDIR 환경은 그대로 유지한다.
  후보 kernel policy는 `uname`의 공개 `kern.version`
  조회와 native TLS의 `com.apple.trustd`/`com.apple.trustd.agent` 인증서 검증도 허용한다.
  VS Code profile delivery has a bounded 60-second handoff reservation. Once its
  actual PTY PID/birth is adopted, native readiness retains its 10-second limit;
  cancellation and expiry still require descendant cleanup before lease release.
- `macos-network-sandbox.ts`: 별도 커널 정책 후보. 공유 소스 쓰기를 유지하며 현재 attach에는 연결되지 않음. `native/network-launcher/` 후보와 실제 PTY·호스트 zsh/Node/Python 실행을 검증하며, 자기 scheduling·자식 신호와 해당 TTY device만 허용
- `shell-integration-verifier.ts`
- `node-terminal-candidate-provider.ts`

guarded runtime은 private 완료 기록과 복구 helper의 성공 종료를 함께 확인한 뒤
소유권을 반환한다. timeout 중 살아 있는 helper는 같은 예약으로 유지하며 중복
실행하지 않는다. 실패 종료가 확인된 helper만 다음 종료 요청에서 다시 시작할 수
있다. 그 사이 lease·profile·표식을 보존하고, 불일치하는 완료 기록은 성공으로
처리하지 않는다. 실제 테스트에서 기록 문제를 고친 뒤 분리된 자손을 회수하며
다른 네트워크는 실행과 자원 예약을 유지하는지 확인한다.

## 외부 의존성

- `child_process`
- `process`
- `media/native/portmanager_process_lookup`
- `src/shared`

## 주의사항

프로세스 상태 전이의 의미는 `src/core`가 결정하고, 이 모듈은 실행 메커니즘만 제공한다.
현재 Borrowed Network는 협조적인 preload 라우팅이다. 훅 opt-out과 직접 시스템 호출을
권한 경계로 강제하지 않으므로 제품 전체를 악성 코드에 대한 보안 sandbox로 표현하지 않는다.
사용자 선택대로 소스는 공유하고 기존 쓰기를 유지한다. 공유 코드 변경이 다른 네트워크의
다음 실행에 미치는 영향은 이 경계에 포함되지 않으며, 전면적인 악성 코드 격리를 보장할 수 없다.

커널 후보는 시스템 DNS client가 사용하는 canonical Unix endpoint
`/private/var/run/mDNSResponder`만 추가 허용한다. Apple의
[DNS client](https://github.com/apple-oss-distributions/mDNSResponder/blob/main/mDNSShared/dnssd_clientstub.c)와
[IPC 정의](https://github.com/apple-oss-distributions/mDNSResponder/blob/main/mDNSShared/dnssd_ipc.h)를 확인하고,
현재 Mac에서 Node·Python의 일반 도메인 조회를 격리 전후로 비교했다. `/var/run` literal이나
Mach 이름만 허용한 후보는 실패하고 canonical endpoint 후보는 성공했다. raw IP와
다른 Unix socket에 대한 기존 거절은 유지되며, 일반 UDP 전송을 허용하지 않는다.
