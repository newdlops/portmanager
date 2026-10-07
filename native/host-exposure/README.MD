# Host Exposure Native Helper

## 역할

Host Port Exposure의 TCP accept/connect/byte-copy 데이터 plane을 실행한다.

## 책임

- 지정된 host address와 host port에 TCP listener를 연다.
- 연결마다 TypeScript control plane에 target 조회를 요청한다.
- 조회된 target host/port로 TCP 연결을 열고 양방향 byte stream을 전달한다.
- bind 실패, target 조회 실패, socket 오류는 개별 listener 또는 연결 실패로 한정한다.
- connection worker 하나로 양방향 전달하며 연결 수·준비 기한·버퍼 메모리를 제한한다.

## 주요 진입점

- `portmanager_host_exposure_proxy.c`

## 외부 의존성

- POSIX socket API
- `pthread`
- stdin/stdout control protocol
- `native/shared/pm_tcp_proxy.{h,c}`

## 주의사항

확장의 공통 예산에서 이 helper의 연결/upstream/DNS 용량을 먼저 예약한다.
부모가 전달한 worker/DNS env 상한을 공유 TCP adapter가 적용하며, warm/종료
대기 중에도 예약을 유지한다. 단독 CLI 기본값과 확장에서의 기본 예약(32/2)은
구분한다. 전체 정책은 `src/platform/ports/README.MD`에 설명한다.

이 helper는 Host Port Exposure 전용이다. 노출 row의 생성, 중복 검사, target 결정, registry 상태 변경은 TypeScript 계층이 계속 담당한다. helper가 없거나 시작에 실패하면 기존 Node.js proxy가 fallback으로 사용된다.

target 응답 대기는 기본 5초다. PORT_MANAGER_PROXY_ROUTE_TIMEOUT_MS로
TypeScript resolver와 같은 기한을 전달할 수 있다. TCP/DNS 준비는 별도의 기본
5초 기한을 쓰며, 이미 연결된 idle 세션에는 적용하지 않는다. 기본 연결 상한은
256개이고 OS fd 한도가 작으면 더 줄어든다. 준비 실패·reset·정상 양방향 종료
후 fd를 닫은 뒤에만 admission permit을 반환한다.

stdout은 shared FIFO writer가 담당한다. 응답 기한은 enqueue 이전부터 시작하고
출력 backpressure를 기다리는 동안에도 연결 worker는 만료·회수된다. 기존 TCP
세션은 계속 전달하며, control 복구 뒤 늦은 응답으로 target을 다시 열지 않는다.
