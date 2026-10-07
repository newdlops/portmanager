# Native Shared

## 역할

여러 네이티브 바이너리가 함께 사용하는 프로세스 귀속과 개발 진단 유틸리티를 제공한다.

## 책임

- 루프백 연결의 4-tuple로부터 클라이언트 프로세스 pid와 시작 시각(pid 재사용 가드)을 해석한다.
- 해당 프로세스의 환경에서 Port Manager 네트워크 스코프 변수를 읽는다. 프로세스 자신에 스코프가 없으면 조상 프로세스를 얕게 거슬러 올라간다.
- agent 복구가 요청한 환경 변수만 직접 읽어 exact-entry separator가 붙은 텍스트로 제공한다. 큰 비관련 환경값과 `ps` 문자열 경계 오인식을 피한다.
- 모든 함수는 best-effort다. 실패는 음수/실패 반환으로 표현하며, 호출자는 상위 조회로 fallback한다(오귀속하지 않는다).
- TCP helper의 연결 admission, 이름/주소 준비 기한, 양방향 backpressure와 FIN/reset 처리를 공유한다.
- control 출력 FIFO와 monotonic 응답 대기를 공유해 느린 제어 수신자가 연결 worker를 붙잡지 않게 한다.
- `PORT_MANAGER_DEV_LOG`가 명시된 경우 공용 진단 파일에 append하되 64 MiB에서 기록을 중단한다.

## 주요 진입점

- `pm_peer_resolve_client_pid(...)`: 클라이언트 로컬/외부 엔드포인트 → pid(+시작 시각).
- `pm_peer_read_network_id(pid, ...)`: 프로세스(및 조상)의 환경에서 네트워크 스코프 조회.
- `pm_peer_read_environment_text(pid, names, ...)`: 한 프로세스에서 선택한 환경 항목만 exact-entry 형식으로 조회.
- `pm_dev_log(...)`: opt-in 공용 진단 로그 기록.
- `pm_tcp_proxy.{h,c}`: native router와 host exposure가 공유하는 TCP transport.

## 외부 의존성

- macOS: `libproc`의 `proc_listallpids`/`proc_pidinfo`/`proc_pidfdinfo`(공개 API), `KERN_PROCARGS2` sysctl.
- Linux: `/proc/net/tcp{,6}`, `/proc/<pid>/fd`, `/proc/<pid>/environ`, `/proc/<pid>/stat`.
- TCP transport: POSIX socket/poll/fcntl, pthread, C atomics, system resolver.

## 주의사항

- 환경 조회는 동일 uid 프로세스에서만 신뢰할 수 있다(sudo 프로세스 등은 스코프 미해석 → non-network로 취급될 수 있음).
- pcblist_n의 XNU private 구조체 대신 공개 `proc_pidfdinfo` 경로를 쓴다. 연결당 프로세스 fd를 훑으므로 호출자(TypeScript)가 verdict를 캐시해 반복 조회를 피한다.
- 네트워크 스코프 변수 목록과 우선순위는 `portmanager_process_lookup`과 의도적으로 일치시킨다. 변경 시 함께 맞춘다.

TCP transport는 target 정책을 알지 못한다. helper당 기본 256개의 connection worker를
허용하고, listener fd와 RLIMIT_NOFILE을 반영해 admission을 줄인다. 기존 연결을
퇴출하지 않고 초과한 새 연결만 거부한다. 양방향 64KiB 버퍼는 socket write가
막히면 읽기를 제한하며, FIN 뒤에도 반대 방향과 이미 받은 바이트를 보존한다.
reset/error는 두 방향을 함께 정리해 다른 copy thread의 종료를 기다리지 않는다.
macOS는 읽기 버퍼가 찬 events=0 소켓의 reset을 즉시 통지하지 않으므로,
I/O 관심이 없는 방향이 있을 때만 100ms 간격으로 socket error를 확인한다.
정상 FIN과 idle은 이 확인으로 종료하지 않고, 일반 양방향 idle 연결은 무기한 poll한다.

주소 준비는 기본 5초의 monotonic 기한 하나를 DNS와 모든 주소의 connect/EINTR에
공유한다. 숫자 주소는 resolver worker를 만들지 않는다. 이름 조회는 같은 host/port의
진행 중 작업만 공유하고 최대 4개 작업·작업당 64개 주소를 유지한다. 대기자가 모두
만료되어도 반환하지 않은 OS resolver는 최대 4개만 남으며, 반환 시 wakeup pipe와
결과를 회수한다. helper 종료는 이 worker를 join하지 않는다. worker/대기자의
참조가 pipe 수명을 소유하므로 늦은 완료가 재사용된 fd를 깨우지 않는다.
TCP connect가 성공했거나 poll에서 준비됐더라도 반환 직전 monotonic 기한을
다시 확인한다. syscall/준비 이벤트 뒤 worker 실행이 늦어지면 해당 fd를 닫고
전달에 공개하지 않으며, 유휴 세션의 수명에는 이 기한을 적용하지 않는다.

진단용 override: PORT_MANAGER_PROXY_MAX_CONNECTIONS (1~4096),
PORT_MANAGER_PROXY_CONNECT_TIMEOUT_MS (1~600000). 이 adapter는 약 700줄의
단일 TCP 수명 경계로 유지하며, byte pump와 이름 조회를 별도 미니 모듈로 나누지 않는다.
OS DNS 동시 작업은 `PORT_MANAGER_PROXY_MAX_DNS_JOBS`(1~4, standalone 기본 4)로
부모의 예약에 맞춰 줄일 수 있다. 확장 호스트는 공유 예산에서 worker 용량과 DNS
용량을 예약한 뒤 기본 32/2를 전달하며, 실제 child exit 전에 반환하지 않는다.
전체 proxy 예산과 보수적 native 예약의 범위는 `src/platform/ports/README.MD`에 있다.

control 출력은 고정 worker 하나가 nonblocking fd에 FIFO로 전송한다. 최대
4,096프레임·payload 4MiB(프레임당 1KiB)를 유지하고, 한도를 넘으면 enqueue를
실패 처리한다. 진행 중인 부분 프레임은 제거하지 않으므로 복구 뒤에도 wire 경계가
유지된다. control 수신자가 멈춰도 연결 worker의 응답 기한은 계속 흐르며,
늦은 답변은 새 target을 만들지 않는다. 이미 연결된 데이터 pump는 control
정체와 독립적으로 계속 동작한다. 상대 읽기 종료는 FIFO를 회수하고 후속 쓰기를
거부하며, 기존 세션의 수명은 caller의 stdin/owner 종료가 결정한다.

응답 기한은 DNS/TCP와 같은 monotonic clock을 사용한다. Linux는 monotonic
condition, Darwin은 남은 시간의 relative condition wait를 사용하며, signal 후
worker가 늦게 실행된 경우에도 완료 시각을 다시 검사한다. 두 helper에 같은
기한·출력 수명 adapter를 적용해 정책과 저수준 구현의 경계를 유지한다.

## TCP 전송·연결 수명 개선의 검증 (2026-10-07, 공통 예산 도입 전)

Darwin arm64에서 HEAD(fa4c67f)의 host exposure helper와 변경된 helper를 같은
숫자 loopback target에 연결해 각각 유휴 TCP 연결 32개를 유지했다. 각 프로세스를
새로 띄우고 ps로 측정한 결과다.

| 측정 범위: raw helper 1개, 연결 32개 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| 스레드 | 98 | 35 |
| RSS (KiB) | 3,344 | 2,336 |

control FIFO와 준비 완료 기한 재검사를 포함한 최종 helper 측정값이다. 고정 output worker 1개가 추가되어
전달은 연결당 1개 worker, 유휴 32개 연결은 총 35개 thread다.

최종 macOS 기본 전체 검사 817개와 별도 opt-in 연결 귀속·격리·추적 검사 7개가 통과했다.
Linux arm64/Alpine 3.20에서도 최종 router/host helper를 -Wall -Wextra -Werror로
빌드하고 control 정체·FIFO·전송 수명·이름 조회·캐시·브라우저 전송 검사 72개가
통과했다. Darwin arm64의 빌드와 native artifact 검증 11개도 통과했다.

주요 회귀 경계는 대용량 양방향 FIN, 연결된 세션 유지, backpressure 중 reset 회수,
초과 연결 거부와 slot 회복, DNS 지연/동시 조회/늦은 결과 회수, PID 시작 시각
미확인 cache 금지, overdue timer보다 먼저 도착한 Promise의 POST 전송 차단,
native helper의 preload/scope 정제다. raw helper 측정과 전체 확장 호스트의
프로파일링은 측정 범위가 다르며, 위 RSS는 raw helper에 해당한다.

control 정체 회귀는 READY 이후 실제 kernel pipe를 채워 검증한다. 기존 helper는
250ms 응답 설정에서도 3.5초 뒤 연결 4개가 모두 남았으며, 최종 구현은 네 연결을
만료시키고 기존 연결의 ping/pong을 보존했다. 같은 stream 복구 뒤 늦은 응답은
target을 만들지 않았고 새 연결은 정상 전달했다. 별도의 socket FIFO 검증은
5,000회 enqueue 중 4,096회를 수용·904회를 거부한 뒤, 37바이트씩 읽어
4MiB 전체의 순서와 프레임 바이트 보존을 확인했다.

추가 시간 경계 검사는 시계 역행과 worker/이벤트 실행 지연을 모델링한다. 변경
전에는 대상 검사 9개가 실패했고, 실제 HTTP/HTTPS backend에 기한 뒤 POST가
전달되어 200을 반환했다. 최종 구현은 같은 검사에서 504와 backend POST 0회를
확인했다. syscall 성공·poll 준비 뒤 지연도 native fd를 회수하며, 귀속·완료된
target 캐시는 시스템 시계가 역행해도 원래 경과 시간 TTL에 만료된다. 정상
keep-alive·느린 응답/업로드·SSE/WebSocket/raw 유휴·FIN 보존을 함께 검사했다.
