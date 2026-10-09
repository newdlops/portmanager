# Process Lookup Native Helper

## 역할

Logical Network 라우터가 로컬 클라이언트 프로세스를 터미널 attachment와 route scope에 매핑할 때 필요한 OS process metadata를 조회한다.

## 책임

- PID, PPID, process group, TTY를 포함한 process table snapshot 출력
- 단일 PID의 parent chain, cwd, Port Manager network environment 조회
- route 복구용 단일 capture에서 argv와 environment를 함께 출력
- 플랫폼별 process 조회 API와 `/proc` 접근을 작은 실행 파일 뒤에 숨김
- TypeScript adapter가 실패 시 기존 `ps`/`lsof` 경로로 fallback할 수 있는 JSON contract 제공

## 주요 진입점

- `portmanager_process_lookup.c`
- 실행 파일 명령:
  - `portmanager_process_lookup list`
  - `portmanager_process_lookup inspect <pid>`
  - `portmanager_process_lookup capture <pid>`
  - `portmanager_process_lookup identity <pid>`
  - `portmanager_process_lookup signal <pid> <birth> SIGTERM|SIGHUP|SIGINT|SIGKILL`

## 외부 의존성

- macOS: `sysctl`, `libproc`
- Linux: `/proc`, `/dev/pts`
- 표준 C 런타임

## 주의사항

다른 사용자의 process environment나 cwd는 OS 권한 정책에 의해 숨겨질 수 있다. helper는 가능한 필드만 출력하고, 호출자는 누락된 값에 대해 기존 shell command 기반 fallback을 유지해야 한다.
Linux capture는 `/proc/<pid>/cmdline`과 `/proc/<pid>/environ`을 별도로 읽어 argv/env JSON 배열을 구성한다.

`identity`와 `signal`은 전체 표·env 조회 전에 분기한다. macOS `signal`은 expected birth와
UID, 조회 전후 audit token을 확인하고 kernel PID-version 신호를 호출한다. 결과는
`{pid,birth,signal,sent,error}`이며 성공 exit 0, 거절/미지원 exit 1, 잘못된 인자 exit 2다.
다른 플랫폼이나 API가 없는 OS에서는 숫자 PID kill로 fallback하지 않는다. TypeScript
호출자도 신호 실패를 shell kill로 대체하면 안 된다.
