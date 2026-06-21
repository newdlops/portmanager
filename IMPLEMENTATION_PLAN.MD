# Port Manager Logical Network Implementation Plan

## 방향

Port Manager의 기본 구현 방향은 레거시 포트 재할당 UI에서 Logical Network UI로 전환한다. 기존 daemon, route table, managed process, native hook 코드는 삭제하지 않고 deprecated 상태로 유지한다. 새 화면과 명령은 터미널 프로세스 선택, Logical Network 생성, host port exposure 설정을 중심으로 설계한다.

## 핵심 판단

- 충돌 이후 rerun prompt는 개발 서버가 이미 종료된 뒤라 예방 기능이 아니다.
- 여러 앱이 같은 내부 포트를 동시에 쓰려면 실제 네트워크 격리 또는 그에 준하는 런타임이 필요하다.
- VS Code 확장 단독으로 macOS/Windows/Linux 전체에서 동일한 per-process network namespace를 제공할 수는 없다.
- 따라서 도메인은 `LogicalNetwork`, `TerminalAttachment`, `HostPortExposure`로 먼저 모델링하고, 실제 구현은 `NetworkRuntimeAdapter` 뒤에 둔다.
- 레거시 라우팅 기능은 새 모델의 fallback 또는 adapter 내부 구현으로 흡수할 수 있을 때까지 숨김 상태로 둔다.

## Phase 0: 레거시 UI 숨김

상태: 완료

- 사이드바에서 daemon/routes/managed process/listener 중심 화면을 숨긴다.
- Command Palette와 view toolbar에서 레거시 시작/중지/라우팅 명령을 숨긴다.
- 레거시 코드 경로는 유지해 기존 테스트와 빌드를 깨지 않는다.
- README와 SPEC에 레거시 상태와 새 방향을 명시한다.

## Phase 1: 도메인 모델

상태: 초기 구현 완료

- `LogicalNetwork` 모델 추가
  - id, name, status, runtime adapter, createdAt, metadata
- `TerminalAttachment` 모델 추가
  - networkId, rootPid, processGroupId, shell, tty, attachedAt, status
- `HostPortExposure` 모델 추가
  - hostAddress, hostPort, targetAddress, targetPort, protocol, networkId
- `LogicalNetworkRegistry`와 event contract 추가
- VS Code global state persistence 추가
- 설정 스키마에 기본 runtime adapter와 exposure 기본 host 추가는 예정

## Phase 2: 터미널 탐색

상태: 초기 구현 완료

- OS 전체 process table 기반 terminal candidate scanner 추가
- 터미널 후보를 사용자-facing `TerminalWindow`로 그룹화
  - macOS: Terminal, iTerm2, shell, tty, process group
  - Linux: terminal emulator, shell, tty, process group
  - Windows: Windows Terminal, conhost, PowerShell, cmd, WSL process tree
- VS Code 통합 터미널과 외부 터미널을 같은 `TerminalWindow` 모델로 표시
- 권한 제한과 불완전한 식별 결과를 UI에 표시

## Phase 3: Network Runtime Adapter

상태: 일부 구현

- `NetworkRuntimeAdapter` 인터페이스 정의
  - create network
  - attach terminal/process group
  - apply environment/wrapper
  - create/remove host exposure
  - inspect runtime health
- 첫 adapter 후보 구현 순서
  - Docker/Podman/Colima 계열 adapter
  - Linux network namespace adapter
  - macOS/Windows proxy 또는 VM 기반 adapter
- adapter별 capability를 UI에 노출
  - supportsSameInternalPorts
  - supportsTerminalAttach
  - supportsHostExposure
  - requiresPrivilegedHelper
  - requiresContainerRuntime
- 현재 구현된 adapter
  - `Local TCP Proxy`: host exposure 지원, same internal ports 미지원, terminal attach 미지원

## Phase 4: Host Port Exposure

상태: 초기 구현 완료

- host exposure 생성/삭제/검증 서비스 구현
- `localhost:3004 -> A network:3004` 같은 명시적 매핑 저장
- exposure 생성 전에 실제 TCP bind로 host port 점유 여부 검사
- 충돌 시 실행 이후가 아니라 exposure 설정 단계에서 실패 처리
- exposure 상태를 sidebar에 표시
- extension reload 시 active exposure 재개

## Phase 5: Sidebar UX

상태: 초기 구현 완료

- Logical Networks 섹션
  - 네트워크 생성, 삭제, 상태 확인
- Terminal Windows 섹션
  - 감지된 터미널 창/세션 표시
  - 선택한 터미널 창을 네트워크에 attach
- Host Port Exposures 섹션
  - host port와 내부 target port 매핑 표시
  - 노출 추가, 제거, 복사, 브라우저 열기
- 각 섹션에 command row를 제공해 Command Palette 없이 주요 명령을 실행
- 레거시 라우팅은 사이드바 섹션으로 표시하지 않는다.

## Phase 6: 검증 시나리오

상태: 예정

- A network에서 frontend `3004`, backend `8004` 실행
- B network에서 같은 frontend `3004`, backend `8004` 실행
- host `localhost:3004`는 A frontend로 연결
- host `localhost:3005`는 B frontend로 연결
- A frontend의 backend 호출은 A network 내부 `8004`로 연결
- B frontend의 backend 호출은 B network 내부 `8004`로 연결
- host exposure 충돌은 exposure 생성 단계에서 차단

## 남은 위험

- 외부 터미널을 이미 실행 중인 상태에서 강제로 다른 network namespace에 이동시키는 것은 OS별로 불가능하거나 제한적일 수 있다.
- macOS와 Windows에서 진짜 per-process 네트워크 격리는 privileged helper, VM, container runtime, 또는 proxy 강제가 필요할 가능성이 높다.
- shell script shim, version manager, login shell, terminal app별 process tree가 다르므로 terminal attach는 best-effort로 시작해야 한다.
- 프론트엔드 코드가 빌드 타임에 backend URL을 고정하면 네트워크 격리만으로 해결되지 않고 앱 설정도 함께 다뤄야 한다.
