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
- `repairRoutingState`에서 route shard 반영을 확인한 뒤 성공을 반환하고 scan·게시 실패를 호출자에게 전달
- browser DNS full-replace를 durable shared-state revision으로 fence하고 record table과 fence를 함께 영속화
- OS scan과 독립적인 DNS 응답 스레드의 socket·table 수명 관리
- OS scan을 기다리는 RPC를 보류하고 같은 연결의 DNS 게시·상태 조회를 계속 처리
- 소켓별 출력 FIFO와 전송 기한·메모리 한도를 관리해 느린 수신자가 제어 루프를 막지 않게 처리
- route/DNS 파일 작업을 별도 실행 흐름으로 넘기고 등록 변경의 게시 대기 기한 보장

## 주요 진입점

- `portmanager_agent.c`: Unix-domain socket server와 protocol dispatch
- `portmanager_agent_probe.c`: 터미널 시작용 daemon readiness와 stale-lock 검사
- `portmanager_agent_state.c`: route, process, snapshot, child lifecycle 상태
- `portmanager_agent_json.c`: protocol payload 파싱과 JSON 응답 작성
- `portmanager_agent_dns.c`: DNS publication/fence와 UDP 응답 worker
- `portmanager_agent_scan.{h,c}`: 제한된 subprocess 조회, 결과 공유, 취소·기한·자식 회수
- `portmanager_agent_output.{h,c}`: 공유 불변 출력 프레임, 부분 전송·backpressure, 제어 명령 전송 완료 확인
- `portmanager_agent_publication.{h,c}`: 파일 작업의 직렬 실행, 대기 한도·기한, 완료 응답과 취소 수명

## 외부 의존성

- POSIX socket, fork/exec, posix_spawn, signal, waitpid
- pthread, C atomics (Linux agent도 `-pthread`로 빌드)
- macOS/Linux `lsof` listener scan
- 동일 uid process environment 조회(`native/shared/pm_peer_process`)

## 주의사항

Windows named pipe와 PowerShell listener scan은 native daemon에서 처리하지 않는다.
VS Code 시작 경로는 미지원 플랫폼이나 바이너리 부재 시 기존 Node daemon으로 fallback한다.
명시적 routing repair는 `lsof`의 정상 무결과(exit 1)는 허용하지만 실행/권한/신호 오류를 빈 listener 표로 취급하지 않는다.
DNS 응답 worker는 registry·파일·로그에 접근하지 않고 UDP와 shutdown pipe를 poll한다. DNS 게시 worker가 revision 검증과 영속화를 마친 뒤 control thread가 mutex 아래 레코드 포인터/개수만 교체하고 이전 테이블을 회수한다. packet 생성 중에만 같은 mutex를 잡으며, bind 실패는 control thread의 기존 backoff로 재시도한다. 종료·소켓 오류 시 응답 worker를 깨워 join한 후 descriptor를 닫는다. UDP와 wakeup pipe, 게시 파일은 CLOEXEC으로 managed child에 유출되지 않는다.
managed child의 command/env 구성은 fork 전에 끝낸다. child는 chdir/open/dup2/close/execve/_exit만 사용해 DNS 스레드가 있는 부모에서 libc 상태를 상속한 뒤 잠기는 일을 방지한다.

실행 중 route/DNS 파일 읽기·쓰기·rename은 서로 독립된 게시 worker에서 수행한다. 시작 시 이전 파일 정리와 DNS sidecar 로드는 socket loop 진입 전에 끝낸다. route worker에는 불변 route/관측 사본과 전용 파일 signature·generation 상태만 전달하며 registry는 공유하지 않는다. 첫 미수집 변경부터 최대 250ms, idle 40ms를 기준으로 다음 사본을 예약한다. 진행 중인 쓰기 뒤에는 최신 사본 하나만 병합하며, 새 변경은 별도 기한을 시작해 지속적인 입력 중에도 매 turn 전체 registry를 복사하지 않는다. 이 기한은 게시 예약을 위한 것이며 파일시스템 완료 시간을 보장하지 않는다. 기존 TTL heartbeat도 유지한다.

`flushRouteTables`, noncompact allocation, `repairRoutingState`의 성공은 해당 사본 또는 이를 포함한 후속 사본의 파일 반영이 끝난 뒤 반환한다. repair 강제 재작성 세대는 병합해도 보존하고, 이전 사본 완료가 새 dirty revision을 지우지 않는다. 다른 daemon의 최신 generation은 쓰기 시작과 rename 직전에 확인한다. DNS는 FIFO로 게시하며 직전 완료가 control thread에 적용된 뒤 다음 작업의 revision을 비교한다. authoritative 문서도 rename 직전에 다시 검증하고, 실패 시 기존 파일과 UDP 답변을 유지한다.

network aggregate의 중복 제거는 route identity로 정렬한 뒤 마지막 등장 위치를 선택하고 원래 순서로 복원한다. 기존 마지막 소유자 우선 규칙과 파일 순서를 보존하면서 O(n²) identity 비교가 대규모 표의 게시 기한을 반복해서 소진하는 일을 막는다.

route 게시는 진행 중인 사본과 최신 대기 사본을 합해 256MiB, DNS 게시는 진행 중인 작업을 포함해 최대 32개·사본 32MiB를 보관한다. route 한도는 기존 대규모 라우팅에서 metadata와 배열 여유 용량까지 포함한 사본을 수용한다. 응답 대기는 연결당 128개·전체 1,024개·payload 8MiB로 제한한다. 게시 기한은 최초 큐 진입부터 8초이며 병합으로 연장하지 않는다. 초과 시 성공을 알리지 않고, 반환된 파일 작업은 rename 전에 취소를 확인한다. route 실패는 1초 후 재시도하고 부분 게시·삭제 실패 시 이전 경로와 새 경로를 모두 보관해 남은 정리를 이어간다. 응답 연결이 닫혀도 접수한 작업은 계속 처리한다. 종료는 게시 worker를 기다리는 join을 하지 않는다. worker가 독점 소유한 사본/파일 상태는 작업 반환 시 정리하고, 커널 안에서 멈춘 호출은 standalone daemon 프로세스 종료로 회수한다. 작은 publication adapter는 이 실행·완료·소유권 경계만 담당한다.

`lsof`/fallback `ps`는 `posix_spawn`으로 실행하고 nonblocking pipe로 수집한다. registry 정책은 control thread에서만 실행하며, 요청은 완성된 stdout만 읽는다. 같은 세대의 진행 중인 명령은 공유하지만 완료된 결과를 새 repair에 재사용하지 않는다. stop/remove 같은 topology 무효화는 이전 관측을 폐기하되 최초 요청 기한을 연장하지 않는다. 등록은 해당 process의 revision만 갱신하고 스캔을 취소하지 않는다. 관측 시작 이후 등록된 행은 소유자 변경·missing 판정을 건너뛰고 나머지 행은 정상 reconcile한다. 캐시에도 관측 revision을 보관해 이전 PID가 새 등록을 덮거나 중복 detected 행으로 재생성되지 않게 한다. 동일 등록은 시작 시각과 revision을 보존하고 불필요한 snapshot/route 게시를 만들지 않는다.

명령은 기본 3초, 요청 전체는 8초로 제한한다. 동시에 4개 명령, 최대 128개 작업을 유지하고 stdout은 작업당 4MiB·합계 16MiB까지만 수집한다. 보류 RPC는 최대 1,024개·8MiB이며, 완료 적용은 8건을 처리하거나 5ms가 지나면 다음 루프로 넘겨 control RPC에 기회를 준다. `PORT_MANAGER_AGENT_SCAN_TIMEOUT_MS`는 테스트에서 명령 기한을 단축할 수 있다. 실패·기한 초과의 부분 결과는 버리고, release 조회 실패로 살아 있는 route를 제거하지 않는다. 유효한 기존 listener cache는 실패한 조회로 덮지 않는다.

읽기 요청의 연결 종료는 참조를 해제하고 마지막 독자는 명령의 process group을 취소한다. 이미 접수한 repair/allocation/release는 send-only 호출을 지원하기 위해 연결 종료 뒤에도 완료한다. daemon 종료는 모든 조회 자식을 종료·회수한다. wildcard child reaper와 조회 broker가 종료 상태를 공유해 managed child와 조회 child가 서로의 상태를 잃지 않는다. scan 파일은 이 OS 조회 수명만 담당하는 작은 adapter로 유지한다.

응답·snapshot·control push는 같은 연결의 FIFO로 보내며 출력 함수 안에서 poll하지 않는다. 메인 poll의 별도 출력 cursor로 연결당 최대 64KiB, 전체 한 turn당 최대 256KiB 또는 5ms까지 진행한다. snapshot payload는 구독자 간 공유하고, 아직 한 바이트도 보내지 않은 이전 snapshot만 제거한 뒤 최신 것을 대기 응답 뒤에 붙인다. 부분 전송 중인 NDJSON 프레임과 RPC 응답은 병합하지 않는다.

출력은 연결당 8MiB·128프레임, 전체 payload 64MiB·16,384프레임으로 제한하고 각 프레임은 최초 대기부터 1초 안에 전송해야 한다. snapshot 병합도 기한을 연장하지 않는다. 한도·기한 초과는 해당 연결을 정리하며 이미 적용한 등록은 유지한다. 제어 명령은 전체 프레임 전송 완료 후 RPC 성공을 반환하고, 전송 중 단절·만료는 실패로 알린다. 완료 확인은 연결당 128개·전체 1,024개까지 유지하며 요청자 종료는 확인 참조만 해제한다.

macOS Unix socket은 SHUT_WR에도 HUP를 보고하므로 0바이트 send로 상대의 읽기 종료를 구분한다. 쓰기 방향만 닫힌 요청자는 남은 응답·조회 결과를 받을 수 있고, HUP 뒤 EAGAIN은 20ms 후 재시도해 busy loop를 피한다. daemon 종료도 이미 대기 중인 출력의 기존 기한 안에서 응답을 마무리한다. output 파일은 소켓 출력 수명만 맡는 작은 adapter로 분리했다.
