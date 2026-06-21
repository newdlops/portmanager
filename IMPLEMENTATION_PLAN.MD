# Port Manager MVP Implementation Plan

## MVP 범위

`SPEC.MD`의 Phase 1부터 Phase 4까지 중, 관리형 프로세스 경로를 우선 구현한다.

이번 MVP에서 구현하는 동작:

- 사용자가 VS Code 명령 또는 사이드바에서 관리형 프로세스를 시작한다.
- 확장이 요청 포트의 사용 가능 여부를 확인한다.
- 요청 포트가 사용 중이면 설정된 탐색 정책으로 인접 가용 포트를 찾는다.
- 실제 포트를 프로세스에 주입한다.
- 프로세스의 요청 포트와 실제 포트 매핑을 사이드바에 표시한다.
- 사용자가 사이드바에서 URL 열기, URL 복사, 종료, 재시작, 제거를 수행한다.

이번 MVP에서 제외하는 동작:

- 임의 외부 프로세스의 소켓 바인딩을 OS 수준에서 투명하게 후킹하는 기능
- Docker, Kubernetes, WSL, Remote SSH 자동 포트 매핑
- VS Code task/debug configuration 자동 패치
- webview 기반 고급 GUI

## 구현 단계

### 1. 확장 스캐폴드

상태: 완료

- `package.json` contribution 작성
- Activity Bar와 Processes view 등록
- Command Palette 명령 등록
- TypeScript 빌드 구성
- F5 실행용 VS Code launch configuration 추가

### 2. Core 도메인

상태: 완료

- `PortRoutingService` 구현
- `scanDirection` 기반 후보 포트 생성
- 요청 포트 보존, 실제 포트 분리
- `ManagedProcessRegistry` 구현
- registry change event 제공
- core unit test 추가

### 3. Platform 어댑터

상태: 완료

- Node TCP bind 기반 포트 가용성 확인
- macOS/Linux `lsof`, Windows PowerShell 기반 best-effort owner lookup
- child process launcher 구현
- `PORT`, `${port}`, `--port` 주입 방식 지원
- process exit event 제공
- scanner unit test 추가

### 4. UI와 명령 통합

상태: 완료

- Sidebar TreeDataProvider 구현
- 프로세스 상태, PID, 포트 매핑, URL 표시
- Start, Add Existing, Stop, Restart, Stop All, Remove 명령 연결
- URL 열기와 복사 명령 연결
- Settings 열기 명령 연결

### 5. 검증

상태: 완료

- `npm run compile` 통과
- `npm test` 통과
- 총 14개 unit test 통과

## 후속 구현 후보

- managed process stdout/stderr output channel 연결
- 재시작 시 기존 프로세스 종료 완료 대기
- framework별 기본 실행 프로필 제공
- task/debug configuration 연동
- workspace state 기반 최근 프로세스 프로필 저장
- 통합 테스트에서 Extension Development Host 명령 검증
