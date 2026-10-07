# Platform Ports

## 역할

로컬 TCP 포트의 가용성과 점유 정보를 조회한다.

## 책임

- Node.js TCP server를 사용한 포트 가용성 검사
- 플랫폼별 명령으로 점유 프로세스 후보 조회
- 단일 로컬 agent가 사용할 전체 listening TCP 포트 목록 조회
- Host Port Exposure를 위한 TCP listener/proxy 실행
- 개발 브라우저 세션 격리를 위한 HTTP/WebSocket alias proxy 실행
- 기존 localhost logical-port router listener 정리
- Accepted TCP connection tuple에서 client PID 조회
- 포트 조회 실패를 도메인에서 다룰 수 있는 결과로 변환

## 주요 진입점

- `node-port-scanner.ts`
- `node-listening-port-provider.ts`
- `host-port-proxy.ts`
- `browser-network-proxy.ts`
- `browser-network-proxy-http.ts`: HTTP 헤더·origin 변환과 본문 스트리밍
- `browser-network-proxy-transport.ts`: 요청별 경로 조회·연결 준비·취소와 TCP 접두부 판별
- `logical-port-router.ts`
- `proxy-network-resources.ts`: 공통 예산과 DNS/socket/child/HTTP pool/control의 lease 수명
- `tcp-connection-process-resolver.ts`

## 공통 자원 예산

한 **확장 호스트와 그 proxy 자식 helper**가 `defaultProxyNetworkResources`를
공유한다. Host Exposure, Host Gateway, Browser Proxy, Logical Router를 모두 포함하며,
서비스 재생성으로 아직 끝나지 않은 작업의 예산을 초기화하지 않는다. 별도 확장
호스트/daemon, 사용자 앱과 OS kernel backlog는 이 회계 범위 밖이다. 내장 호출자와
테스트는 `resources` 옵션으로 같은 객체를 주입할 수 있다.

| 자원 | 기본 전체 상한 | 반환 시점 |
| --- | ---: | --- |
| 리스너 용량 | 256 | Node close/실패, native CLOSED/실패/exit |
| 클라이언트 연결 용량 | 1,024 | Node socket close, native helper exit |
| upstream socket 용량 | 1,024 | 실제 close; HTTP 유휴 풀도 포함 |
| native helper | 8 | 실제 exit 또는 spawn 실패 |
| DNS 작업 용량 | 32 | OS callback 또는 native helper exit |
| 실제 route resolver 작업 | 64 | 원래 Promise의 완료·실패 |
| HTTP 활성 요청 | 256 | upstream request close 뒤 Agent 정리 |
| HTTP 대기 요청 | 256 | admission·취소·만료 |
| 보관하는 유휴 HTTP socket | 64 | 재사용·close·30초 경과 |
| 부모→native 제어 payload | 512KiB | write callback; helper별 64KiB |

native helper는 시작 전에 연결/upstream 용량을 각 기본 32개(요청 상한이 더
작으면 그 값), DNS 용량을 기본 2개 예약한다. native env로 전달해 실제
worker/resolver의 상한도 같아진다. **예약은 사용량보다 보수적**이며 유휴
helper도 차지한다. 초과 helper는 Node fallback으로 열되 그 경로도 공통 예산을
따른다. Host helper는 숫자 bind 주소에 리스너 1개, hostname에 최악의 8개를 예약한다.
공유 native router는 dual-stack LISTEN마다 2개를 예약하고 CLOSED 확인까지
반환하지 않는다. 같은 포트의 reopen은 이전 CLOSE 확인 뒤 시작해 이전 답변이
새 예약을 해제하지 않게 한다. 리스너만 내려도 기존 native 스트림과 warm helper의
연결/DNS 예약은 유지하며, dispose/exit가 이를 반환한다.

Node DNS는 같은 hostname/family/hints/all/order의 **진행 중 조회만** 공유한다.
동시 OS 호출은 broker 전체에서 기본 4개이며 숫자 주소는 이를 거치지 않는다.
socket 취소는 기다리는 callback을 즉시 제거하고, OS 작업은 실제 callback까지
명목 슬롯을 차지한다. timeout/retry가 중단할 수 없는 OS 작업을 계속 늘리지 않는다.
주소 목록은 순서를 보존한 최대 64개이고 Node의 IPv4/IPv6 fallback을 유지한다.
완료 결과를 DNS cache로 보관하지 않는다. 취소된 shared route waiter도 원래
Promise에서 분리하되 실제 resolver 작업의 슬롯은 조기 반환하지 않는다.

Logical Router의 Node fallback도 route/TCP 준비를 각 5초로 제한하고 FIN 응답을
보존한다. HTTP의 전역 활성/대기 또는 upstream/DNS 예산 초과는 503이며 POST를
재실행하지 않는다. raw는 새 연결만 거부하고 기존 세션을 퇴출하지 않는다.
유휴 풀 만료는 활성 SSE/WS/raw에 적용하지 않는다. 거부 socket의 비동기 close 등
일시적 정리 단계는 admission 수치와 구분하며, OS RSS 자체의 제한 기능은 아니다.

control write는 1KiB 이내의 단일 프레임만 enqueue하며 부분 전송은 Node가
보존한다. LISTEN을 enqueue하지 못하면 새 예약을 반환한다. CLOSE는 drain과
공통 control 예산 반환 때 재시도하고 CLOSED/exit 전 예약을 반환하지 않는다.
진단은 공유 dev-log의 `proxy-budget`에 resource/used/max만 남기며 자원별 1초에
한 번으로 제한한다. 이 adapter는 관련 IO 자원의 예산 수명을 소유하는 하나의
경계로 유지한다. 순수 카운터 정책은 core에 두고 작은 파일을 억지로 합치지 않는다.

### 검증 (2026-10-07)

Darwin arm64 기본 전체 검사 843개 중 836개 통과·opt-in 7개 skip, 별도 opt-in
실행 7개 통과. Linux arm64/Alpine 3.20에서 두 helper의 `-Wall -Wextra -Werror`
빌드와 DNS/예산/전송/캐시 90개, 추가 CLOSE/reopen 경계 1개가 통과했다.
Darwin native build/artifact 검증 11개도 통과했다.

새 공통 예산 검사는 다음을 실제 TCP/HTTP/native 또는 지연 OS callback adapter로
확인한다: 네 owner의 공유 admission, 실패 bind/실제 close 반환, 취소 뒤 DNS 4개
상한 유지와 숫자 주소 독립성, 동일 이름/다른 포트 공유 및 IPv4/IPv6 fallback,
실제 route 작업의 늦은 완료와 canceled waiter 1,000개의 callback 제거,
origin 간 HTTP 활성/대기 제한과 미전송 POST, 전역 유휴 풀 상한/expiry와 SSE 보존,
native/Node 혼합 예약, warm router retirement, 중복 close, 비동기 Agent factory,
제어 큐의 프레임 보존 및 가용 용량 뒤 CLOSE 재시도·동일 포트 reopen 회계.

전체 검사 중 agent의 10,000건 publication 부하 검사가 한 차례 기한을 넘겼다.
변경하지 않은 agent의 공유 dev-log 단독 재현에서 재시도 후 10,000건을 게시했고,
최종 전체 실행에서도 통과했다. 검사 기준이나 production 기한은 변경하지 않았다.
이 검증은 RSS 자체의 상한 또는 여러 확장 호스트의 머신 전체 예산을 증명하지 않는다.

## 외부 의존성

- `net`
- `child_process`
- `media/native/portmanager_host_exposure_proxy`
- 운영체제별 포트 조회 명령

## 주의사항

Host exposure의 Node fallback도 연결 수(기본 256)와 target 조회/TCP 준비
기한(각 기본 5초)을 적용한다. 진행 중 조회는 완료된 결과의 150ms TTL과 별개로
공유하고 실패/만료 결과는 보관하지 않는다. FIN을 받은 요청의 지연된 응답은
보존하며, 확인된 reset·취소·owner 종료 뒤에는 새 upstream을 만들지 않는다.
동일 exposure의 bind는 하나로 합치고 close/dispose가 늦은 bind 결과를 폐기한다.
native host helper는 node-runtime의 공통 환경 정제를 재사용해 terminal preload와
network scope를 상속하지 않는다. 이미 선택된 실제 좌표가 다시 라우팅되지 않게 한다.
브라우저 listener도 protocol sniff 이전부터 기본 256개 TCP client를 제한하며,
HTTP pool 밖의 TLS/raw/upgrade/조회 대기를 포함한다. 초과 client는 조회와 greeting
probe 전에 거부하고 기존 세션은 유지한다. lookup 완료에서는 monotonic 기한을
재확인하므로 busy host의 overdue timer보다 앞선 Promise도 upstream을 만들 수 없다.
완료된 host target cache도 monotonic TTL을 사용한다. Node TCP/TLS의 준비 이벤트는
기한을 다시 검사하며, 브라우저는 이 검사를 Node ClientRequest의 준비 이벤트
전송보다 먼저 실행한다. 늦은 이벤트는 POST·upgrade handshake·raw 접두부를
전송하지 않고 준비 소켓을 회수한다. 정상 준비 뒤 앱 응답·FIN·유휴에는 적용하지 않는다.

명령 실행 실패는 확장 전체 실패가 아니라 세부 정보 누락으로 처리한다.
`host-port-proxy.ts`는 Host Port Exposure를 위한 listener/proxy만 담당한다. 가능한 환경에서는 native helper로 accept/connect/byte-copy 데이터 plane을 실행하고, helper가 없거나 시작에 실패하면 Node.js stream proxy로 fallback한다. 이 proxy는 컨테이너 수준의 Logical Network 격리를 제공하지 않으며, 터미널 프로세스가 호스트 포트 namespace를 점유하지 않게 만드는 책임을 갖지 않는다.
`browser-network-proxy.ts`는 개발 브라우저가 네트워크별 loopback host로 접속하도록 하는 HTTP/WebSocket proxy다. 브라우저 cookie jar는 alias host 기준으로 분리하고, upstream web server에는 localhost origin처럼 보이도록 request/response metadata를 rewrite한다.
HTTP 변환은 `browser-network-proxy-http.ts`가 맡는다. 본문은 UTF-8 decoder와 기존 rewrite 순서를 보존하는 bounded suffix 처리로 전달하며, 본문 전체를 모으지 않는다. 각 단계는 URL의 미완성 scheme/host/port와 이전 정규식의 경계만 보관한다. `pipeline`이 backpressure·본문 오류·취소를 전파하고, 재작성 응답은 기존 Content-Length를 제거한다. SSE와 재작성하지 않는 encoding/content-type은 그대로 스트리밍한다.
요청 수명은 `browser-network-proxy-transport.ts`가 담당한다. listener/pool reconciliation과 독립적인 책임이므로 별도 파일로 유지한다. `resolveTimeoutMs`(기본 10초)는 경로 조회를, `connectTimeoutMs`(기본 5초)는 socket 할당 후 TCP/TLS 준비를 제한한다. HTTP timeout은 504, 다른 연결 오류는 502이며 자동 재전송은 없다. 취소와 owner 인계는 아직 진행 중인 조회를 기다리지 않고 요청의 대기 상태를 해제한다. shared resolver의 늦은 성공·실패는 소비하되 upstream socket을 만들지 않는다. 타이머는 준비 완료·취소·오류 시 해제하며, 앱 응답 대기·업로드·SSE/WebSocket/raw의 유휴 시간은 제한하지 않는다.

HTTP는 listener별 upstream origin마다 기본 64개 동시 요청·128개 대기 요청을 허용한다(`maxConcurrentHttpRequests`/`maxQueuedHttpRequests`). 대기는 `queueTimeoutMs`(기본 10초)로 제한하며 초과 504, 대기열 포화 503을 반환한다. `ClientRequest` 생성 전에 FIFO admission을 적용하므로 취소한 요청은 Node Agent 내부 대기열에 남지 않는다. 연결 종료·owner 인계는 대기 항목을 즉시 제거하고, upstream 요청 close 뒤 Agent가 socket을 정리한 다음 다음 요청을 허용한다. SSE는 끝날 때까지 동시 요청 한 자리를 유지하며, 만료·취소된 POST는 자리가 나도 보내지 않는다.
실제로 대기했던 HTTP 요청은 permit을 얻은 뒤 경로를 다시 조회한다. upstream host/port/protocol이 바뀌면 이전 permit을 반환하고 새 origin의 admission을 거친다. 경로 재조회와 반복 이동은 최초 대기 기한을 공유하며, 전송 전 취소·만료는 permit을 반환한다. 아직 보내지 않은 요청만 재검증하고 자동 재전송하지 않는다.
스니퍼는 HTTP method의 접두부를 최대 8바이트까지 조합하므로 첫 패킷이 `G` 하나여도 Host/origin 재작성 경로를 유지한다. raw 프로토콜의 `G` 같은 모호한 접두부는 `sniffTimeoutMs`(기본 1초) 후 원래 바이트로 전달한다. 이 타이머는 첫 모호한 바이트에서 시작하며 새 패킷으로 연장하지 않는다. FIN 전에 받은 모호한 접두부도 raw 경로로 전달한다. 소비한 접두부는 별도 head로 보내므로 이미 end가 발생한 readable stream에 unshift하지 않는다.

클라이언트가 아무 바이트도 보내지 않으면 `serverGreetingDelayMs`(기본 100ms) 뒤 upstream에 연결해 서버 선응답을 기다린다. 실제 인사말을 받은 경우에만 raw forwarding을 확정하고 모든 바이트를 보존한다. 먼저 클라이언트 데이터가 오면 준비 중인 연결·조회 대기를 취소하고 기존 HTTP/TLS/raw 판별로 진행하므로 느린 ClientHello도 재작성 경로를 유지한다. 빠르게 요청을 보내는 일반 브라우저에는 추가 upstream 연결이 생기지 않는다.
인사말 없이 서버가 닫히면 idle 클라이언트와 준비 소켓을 함께 정리한다. raw/upgrade 양쪽 소켓은 half-close를 허용해 FIN을 반대편 쓰기로 전달하고, 남은 방향의 데이터와 write buffer를 끝까지 비운다. 정상 close는 상대 소켓을 즉시 destroy하지 않으며, 오류·reset·owner 해제는 양쪽을 정리한다.
브라우저 proxy의 bind 전 TCP 점유 확인은 250ms 안에 끝나야 한다. SYN이 버려지는 alias 하나가 다른 네트워크 listener 준비를 무기한 막으면 안 되며, timeout을 빈 포트라는 증거로 쓰지 않고 해당 후보를 실패 처리한다.
독립적인 endpoint의 bind는 최대 8개씩 준비한다. 같은 주소/포트 후보는 순서를 유지하고 wildcard·hostname·IPv6의 겹침은 보수적으로 직렬화한다. 실패 시 100ms부터 지수 backoff(기본 상한 30초)로 자동 재시도하며, `onRetryDue`로 extension의 lease 검증·최신 상태 조합·owner endpoint 게시 흐름에 재진입한다. endpoint 제거, 명시적 close, 소유권 인계와 dispose는 재시도를 취소한다. 한 sync의 TLS identity/지문은 한 번 읽어 공유하되, 다음 sync에서 인증서 교체를 다시 확인한다.
`logical-port-router.ts`는 과거 localhost logical-port listener 구현이다. 현재 extension 서비스는 애플리케이션 요청 포트를 직접 점유하지 않도록 이 router를 열지 않고, 기존 extension host에서 이미 열린 listener를 닫는 용도로만 빈 sync를 호출한다.
