# Native Agent

## 역할

Port Manager의 단일 로컬 daemon을 저수준 POSIX 프로세스로 제공한다.

## 책임

- 기존 NDJSON agent socket 프로토콜 수신
- logical port route 할당과 route table 파일 갱신
- hook/CLI/VS Code에서 등록한 프로세스 registry 유지
- managed process start/stop/restart/remove 처리
- lsof 기반 TCP listener snapshot 생성
- VS Code/daemon 재시작 뒤 생존한 hook process의 route를 fresh listener scan으로 복구
- `repairRoutingState`에서 route shard를 동기적으로 강제 재발행하고 scan 실패를 호출자에게 전달

## 주요 진입점

- `portmanager_agent.c`: Unix-domain socket server와 protocol dispatch
- `portmanager_agent_probe.c`: 터미널 시작용 daemon readiness와 stale-lock 검사
- `portmanager_agent_state.c`: route, process, snapshot, child lifecycle 상태
- `portmanager_agent_json.c`: protocol payload 파싱과 JSON 응답 작성

## 외부 의존성

- POSIX socket, fork/exec, signal, waitpid
- macOS/Linux `lsof` listener scan
- 동일 uid process environment 조회(`native/shared/pm_peer_process`)

## 주의사항

Windows named pipe와 PowerShell listener scan은 native daemon에서 처리하지 않는다.
VS Code 시작 경로는 미지원 플랫폼이나 바이너리 부재 시 기존 Node daemon으로 fallback한다.
명시적 routing repair는 `lsof`의 정상 무결과(exit 1)는 허용하지만 실행/권한/신호 오류를 빈 listener 표로 취급하지 않는다.
