# Platform Ports

## 역할

로컬 TCP 포트의 가용성과 점유 정보를 조회한다.

## 책임

- Node.js TCP server를 사용한 포트 가용성 검사
- 플랫폼별 명령으로 점유 프로세스 후보 조회
- 단일 로컬 agent가 사용할 전체 listening TCP 포트 목록 조회
- Host Port Exposure를 위한 TCP listener/proxy 실행
- Logical Network 내부 호출을 위한 localhost logical-port router 실행
- Accepted TCP connection tuple에서 client PID 조회
- 포트 조회 실패를 도메인에서 다룰 수 있는 결과로 변환

## 주요 진입점

- `node-port-scanner.ts`
- `node-listening-port-provider.ts`
- `host-port-proxy.ts`
- `logical-port-router.ts`
- `tcp-connection-process-resolver.ts`

## 외부 의존성

- `net`
- `child_process`
- 운영체제별 포트 조회 명령

## 주의사항

명령 실행 실패는 확장 전체 실패가 아니라 세부 정보 누락으로 처리한다.
`host-port-proxy.ts`는 Host Port Exposure를 위한 listener/proxy만 담당한다. 이 proxy는 컨테이너 수준의 Logical Network 격리를 제공하지 않으며, 터미널 프로세스가 호스트 포트 namespace를 점유하지 않게 만드는 책임을 갖지 않는다.
