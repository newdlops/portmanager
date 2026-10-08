# Agent

## 역할

Port Manager agent 모듈은 OS당 하나만 실행되는 로컬 프로세스의 내부 서버를 담당한다.
여러 VS Code 창은 이 agent와 소켓으로 통신하며, agent는 관리형 프로세스와 전체 listening port
상태를 하나의 스냅샷으로 합쳐 제공한다.

## 책임

- 단일 process-wide `ManagedProcessRegistry` 유지
- 관리형 프로세스 실행 프로필 저장과 재시작 지원
- 전체 listening TCP port 목록 조회 결과를 agent snapshot에 병합
- NDJSON 기반 request/response 프로토콜 처리
- 상태 변경 시 연결된 모든 클라이언트에 snapshot 이벤트 브로드캐스트

## 주요 진입점

- `protocol.ts`: NDJSON 프로토콜 타입, 인코딩, 디코딩
- `agent-authorization.ts`: private controller/network 키의 원자적 생성과 권한 검증
- `port-manager-agent.ts`: agent 서버와 도메인 동작 구현
- `agent-main.ts`: socket path 인자를 받아 실제 agent 프로세스를 시작하는 CLI 진입점

## 외부 의존성

- `src/core`: 포트 라우팅과 프로세스 레지스트리
- `src/platform/process`: Node child process launcher
- `src/platform/ports`: 포트 사용 가능 여부와 listening port 조회 어댑터
- Node.js `net`: 로컬 소켓 서버

## 주의사항

이 모듈은 VS Code API를 import하지 않는다. Extension Host는 agent client를 통해서만 이 모듈과
통신해야 하며, 여러 창이 떠 있어도 agent 프로세스는 하나만 유지되는 것을 전제로 한다.

관리 RPC와 snapshot 구독은 controller 키가 필요하다. 키는
`~/.portmanager/security/agent-control/<socket UTF-8 hex>.key`에 0600으로 보관하며
workload 환경에 전달하지 않는다. 네트워크 키는 옆의 `.key.scopes/id-<network-id hex>.key`에
네트워크의 loopback 주소와 함께 보관하고, 새 터미널에는 해당 네트워크 키만 전달한다.
생성한 attach/restore 스크립트에는 키 경로만 기록한다. 읽기 가능한 공유 소스에 키 값을
저장하면 다른 네트워크가 이를 읽을 수 있으므로 금지한다.

Node 소켓은 kernel peer PID를 제공하지 않아 workload RPC를 거부한다. controller 동작과
익명 `daemonStatus` readiness는 유지한다. `controllerAuthorizationVersion: 1`과
`authenticatesNetworkPeers`로 이 경계를 구분한다. 강제 격리 attach는 후자를 확인해야 하며
구형 daemon이나 Node fallback을 동등한 보안 경계로 취급하지 않는다. 파일 모드만으로
같은 UID의 비격리 프로세스를 차단하지는 않는다. 별도 커널 정책/고정 scope broker와의
제품 연결은 아직 미완료다.
