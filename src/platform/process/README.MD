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

- `shell-profile.ts`: PM이 소유한 shell profile 경계의 설치·마이그레이션·복구
- `node-process-launcher.ts`
- `node-runtime.ts`
- `node-process-table.ts`
- `node-process-environment.ts`
- `native-process-lookup.ts`: `identity <pid>`는 전체 표·env 조회 없이 OS PID/birth를 읽는다. 기존 inspect/capture의 env networkId는 보안 권한을 대신하지 않음
- `native-executable.ts`
- `network-file-scaffold.ts`: 0700 디렉터리, 0600 파일, 원자적 미교체 게시 및 symlink 거부
- `macos-network-runtime.ts`: protected artifact/profile publication, fixed-id broker ownership, trusted readiness and shared native reservations; PTY/UI stays with the extension adapter.
- `macos-network-sandbox.ts`: 별도 커널 정책 후보. 공유 소스 쓰기를 유지하며 현재 attach에는 연결되지 않음. `native/network-launcher/` 후보와 실제 PTY·호스트 zsh/Node/Python 실행을 검증하며, 자기 scheduling·자식 신호와 해당 TTY device만 허용
- `shell-integration-verifier.ts`
- `node-terminal-candidate-provider.ts`

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
