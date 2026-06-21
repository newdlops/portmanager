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
