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
- `tcp-connection-process-resolver.ts`

## 외부 의존성

- `net`
- `child_process`
- `media/native/portmanager_host_exposure_proxy`
- 운영체제별 포트 조회 명령

## 주의사항

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
