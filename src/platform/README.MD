# Platform

## 역할

운영체제, Node.js, VS Code 외부 시스템과 직접 맞닿는 로우레벨 어댑터를 담당한다.

## 책임

- TCP 포트 가용성 확인
- 포트 점유 프로세스 조회
- child process 실행과 종료
- 플랫폼별 명령 차이 흡수

## 주요 진입점

- `ports/node-port-scanner.ts`
- `process/node-process-launcher.ts`

## 외부 의존성

- Node.js standard library
- `src/shared`

## 주의사항

플랫폼별 분기는 이 계층 내부에 가둔다. 도메인 정책은 `src/core`에서 처리한다.
