# Platform

## 역할

운영체제, Node.js, VS Code 외부 시스템과 직접 맞닿는 로우레벨 어댑터를 담당한다.

## 책임

- TCP 포트 가용성 확인
- 포트 점유 프로세스 조회
- child process 실행과 종료
- 플랫폼별 명령 차이 흡수
- opt-in 개발 로그의 bounded file sink 제공

## 주요 진입점

- `ports/node-port-scanner.ts`
- `process/node-process-launcher.ts`
- `network/container-runtime.ts`
- `dev-log.ts`

## 외부 의존성

- Node.js standard library
- `src/shared`

## 주의사항

플랫폼별 분기는 이 계층 내부에 가둔다. 도메인 정책은 `src/core`에서 처리한다.
개발 로그는 기본 비활성화하며, 활성화해도 64 MiB에서 기록을 멈춰 프로세스 시작 경로에 무제한 동기 I/O가 생기지 않게 한다.
