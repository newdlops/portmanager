# Core

## 역할

Port Manager의 순수 도메인 로직을 담당한다.

## 책임

- 요청 포트와 실제 포트 매핑 결정
- 해시 기반 논리 라우팅과 nearest 포트 탐색 정책 적용
- 관리 중인 프로세스 상태 저장과 전이
- 프로세스 실행 요청 모델 정의

## 주요 진입점

- `port-routing.ts`
- `process-registry.ts`
- `terminal-conflict-parser.ts`

## 외부 의존성

- `src/shared`

## 주의사항

이 모듈은 `vscode`, `child_process`, 운영체제 명령을 직접 import하지 않는다.
