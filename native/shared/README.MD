# pm_peer_process

## 역할

로컬 루프백 TCP 연결을 소스 프로세스로 귀속(attribution)시키는 공용 네이티브 모듈이다. 논리 포트 게이트웨이(라우터)가 accept한 연결이 어느 논리 네트워크에 속하는지 판단하는 1차 신호를 제공한다.

## 책임

- 루프백 연결의 4-tuple로부터 클라이언트 프로세스 pid와 시작 시각(pid 재사용 가드)을 해석한다.
- 해당 프로세스의 환경에서 Port Manager 네트워크 스코프 변수를 읽는다. 프로세스 자신에 스코프가 없으면 조상 프로세스를 얕게 거슬러 올라간다.
- 모든 함수는 best-effort다. 실패는 음수/실패 반환으로 표현하며, 호출자는 상위 조회로 fallback한다(오귀속하지 않는다).

## 주요 진입점

- `pm_peer_resolve_client_pid(...)`: 클라이언트 로컬/외부 엔드포인트 → pid(+시작 시각).
- `pm_peer_read_network_id(pid, ...)`: 프로세스(및 조상)의 환경에서 네트워크 스코프 조회.

## 외부 의존성

- macOS: `libproc`의 `proc_listallpids`/`proc_pidinfo`/`proc_pidfdinfo`(공개 API), `KERN_PROCARGS2` sysctl.
- Linux: `/proc/net/tcp{,6}`, `/proc/<pid>/fd`, `/proc/<pid>/environ`, `/proc/<pid>/stat`.

## 주의사항

- 환경 조회는 동일 uid 프로세스에서만 신뢰할 수 있다(sudo 프로세스 등은 스코프 미해석 → non-network로 취급될 수 있음).
- pcblist_n의 XNU private 구조체 대신 공개 `proc_pidfdinfo` 경로를 쓴다. 연결당 프로세스 fd를 훑으므로 호출자(TypeScript)가 verdict를 캐시해 반복 조회를 피한다.
- 네트워크 스코프 변수 목록과 우선순위는 `portmanager_process_lookup`과 의도적으로 일치시킨다. 변경 시 함께 맞춘다.
