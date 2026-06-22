# Platform Process

## 역할

관리형 프로세스를 실제 OS child process로 실행하고 종료한다.

## 책임

- 실행 명령 시작
- 실제 포트를 환경 변수와 템플릿에 주입
- PID와 종료 이벤트 추적
- 설정된 종료 신호 전달
- OS process table에서 터미널 후보 탐색
- OS process table에서 PID, PPID, PGID, TTY 관계 조회
- OS process environment에서 Port Manager logical network scope 조회
- UI가 터미널 창/세션으로 그룹화할 수 있는 tty, process group, console 식별자 제공

## 주요 진입점

- `node-process-launcher.ts`
- `node-runtime.ts`
- `node-process-table.ts`
- `node-process-environment.ts`
- `node-terminal-candidate-provider.ts`

## 외부 의존성

- `child_process`
- `process`
- `src/shared`

## 주의사항

프로세스 상태 전이의 의미는 `src/core`가 결정하고, 이 모듈은 실행 메커니즘만 제공한다.
