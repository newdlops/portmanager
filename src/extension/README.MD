# Extension

## 역할

VS Code 확장의 활성화 지점과 명령 등록을 담당한다.

## 책임

- 확장 activation과 dispose lifecycle 관리
- Port Manager 서비스 조립
- Command Palette 명령 등록과 레거시 명령 숨김
- Sidebar TreeDataProvider 등록
- Logical Network service 조립과 VS Code global state persistence
- 새 VS Code 터미널에 native hook 환경 변수 주입
- VS Code 터미널 listen 실패 감지와 라우팅 재실행 제안

## 주요 진입점

- `activate.ts`
- `commands.ts`
- `network-service.ts`
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
Logical Network 전환 기간에는 기존 라우팅 명령 구현을 유지하되 기본 UI와 Command Palette에서는 노출하지 않는다.
기본 activation은 새 Logical Network service를 시작하며, 레거시 agent/hook/terminal failure monitor는 자동 시작하지 않는다.
Logical Network는 컨테이너 수준의 격리 런타임이 있을 때만 생성/attach해야 한다. `Local TCP Proxy`는 host exposure 보조 기능일 뿐 터미널 포트 namespace를 분리하지 않는다.
Docker/Podman runtime이 감지되면 네트워크 생성과 터미널 attach는 `src/platform/network` adapter를 통해 수행한다.
