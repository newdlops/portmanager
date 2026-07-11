# Extension

## 역할

VS Code 확장의 활성화 지점과 명령 등록을 담당한다.

## 책임

- 확장 activation과 dispose lifecycle 관리
- Port Manager 서비스 조립
- Command Palette 명령 등록과 레거시 명령 숨김
- Sidebar TreeDataProvider 등록
- Logical Network service 조립과 VS Code global state persistence
- Logical Network 생성 시 Linux namespace/Borrowed Network runtime 선택 조정
- 선택된 터미널에 network namespace attach 명령 또는 native hook 환경 주입
- VS Code 터미널 listen 실패 감지와 라우팅 재실행 제안은 legacy recovery path로 유지

## 주요 진입점

- `activate.ts`
- `commands.ts`
- `network-service.ts`
- `terminal-hook-environment.ts`
- `terminal-conflict-monitor.ts`
- `terminal-secure-browser-link-provider.ts`

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
VS Code 새 터미널의 정적 라우팅 context는 process creation에서 복사하고, native preload·runtime shim PATH·BASH_ENV·활성화 플래그만 사용자 shell profile 이후 shell integration에서 주입한다. profile에 설치된 외부 터미널 hook도 VS Code의 pending shell-integration 환경을 감지하면 활성화를 미뤄 runtime manager 초기화를 방해하지 않는다. shell integration이 동작하지 않는 터미널은 자동 주입하지 않으며, 이 경우 명시적 terminal attach 스크립트를 사용한다. attach 스크립트는 Compose 함수 본문을 eager parse하지 않고 Docker/Podman PATH shim이 실제 runtime 호출 시 로드한다.
`escapedServerRespawn`이 꺼진 기본 경로에서는 native hook의 control-channel thread/socket을 만들지 않는다. 이 채널은 destructive respawn 기능 전용이며, 일반 prompt helper의 spawn 경로에 들어가면 안 된다.
Logical Network는 터미널 bind 포트를 호스트 namespace에서 직접 점유하지 않게 만드는 runtime이 있을 때만 생성/attach해야 한다. `Local TCP Proxy`는 host exposure 보조 기능일 뿐 터미널 포트 namespace를 분리하지 않는다.
Linux Docker/Podman runtime이 감지되면 `src/platform/network` adapter가 전역 bridge network와 logical network별 namespace holder container를 관리한다. macOS에서는 Docker Desktop network namespace를 host 터미널에 직접 빌릴 수 없으므로 Native Socket Hook runtime을 Borrowed Network 구현으로 사용한다. Native Socket Hook은 컨테이너를 만들지 않고 선택된 shell에 hook 환경을 주입하므로, attach 이후 시작한 프로세스에만 적용된다.
