# Extension

## 역할

VS Code 확장의 활성화 지점과 명령 등록을 담당한다.

## 책임

- 확장 activation과 dispose lifecycle 관리
- Port Manager 서비스 조립
- Command Palette 명령 등록
- Sidebar TreeDataProvider 등록
- 새 VS Code 터미널에 native hook 환경 변수 주입
- VS Code 터미널 listen 실패 감지와 라우팅 재실행 제안

## 주요 진입점

- `activate.ts`
- `commands.ts`
- `terminal-hook-environment.ts`
- `terminal-conflict-monitor.ts`

## 외부 의존성

- VS Code Extension API
- `src/core`
- `src/platform`
- `src/ui`
- `src/config`

## 주의사항

이 모듈은 여러 계층을 조립할 수 있지만 도메인 판단 로직을 직접 구현하지 않는다.
