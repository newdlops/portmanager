# portmanager_process_tracker

## 역할

attach된 터미널 셸의 프로세스 서브트리를 논리 네트워크에 실시간 귀속시키는 장수 헬퍼다. 환경변수 주입 없이, 그리고 fork/데몬화(setsid)/reparent(launchd)로 라이브 부모 체인이 끊긴 뒤에도 프로세스의 네트워크 멤버십을 유지한다.

## 책임

- attach된 셸 PID를 root로 받아 그 서브트리의 프로세스를 네트워크에 매핑한다.
- fork 시점에 멤버십을 기록해, 이후 프로세스가 데몬화하거나 launchd로 reparent돼도 매핑이 남게 한다.
- QUERY 시 (1) 기록된 맵 → (2) 라이브 조상(ppid) 워크 순으로 즉시 해석하고, 해석된 자손을 맵에 기록한다.
- 주기적 proc 스캔으로 죽은 프로세스를 제거하고, 이벤트 스트림이 놓친 자손(ppid가 멤버)을 입양한다.

## 주요 진입점

stdin 제어 프로토콜(탭 구분), stdout 응답:

- `TRACK\t<pid>\t<networkId>` — 서브트리 root를 네트워크에 부착
- `UNTRACK\t<networkId>` — 해당 네트워크의 모든 pid 매핑 제거
- `QUERY\t<pid>` → `NETWORK\t<pid>\t<networkId|->`
- `SNAPSHOT` → 매핑마다 `MEMBER` 한 줄, 끝에 `END`

시작 시 `READY` 한 줄.

## 외부 의존성

- macOS/BSD: `kqueue` `EVFILT_PROC`/`NOTE_TRACK`(실시간 서브트리 추적, best-effort), `EVFILT_TIMER`, `libproc`(proc 스캔·ppid).
- Linux: `/proc` 스캔·`/proc/<pid>/stat`(ppid). kqueue 없으면 주기적 스캔만으로 동작.

## 주의사항

- `NOTE_TRACK`의 자손 이벤트는 best-effort다(폭주·`NOTE_TRACKERR` 시 유실 가능). **정확성의 1차 보장은 QUERY의 on-demand ppid 워크와 주기적 reconcile**이고, `NOTE_TRACK`은 지연을 줄이는 보조 수단이다.
- 매핑은 root의 uid로만 신뢰 가능한 정보에 의존하지 않는다(ppid·proc 테이블은 동일 유저 범위에서 안정적).
- `PORT_MANAGER_PROCESS_TRACKER_DEBUG=1`로 이벤트/입양 로그를 stderr에 켤 수 있다.
