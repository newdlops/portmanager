# Platform Network

## 역할

Logical Network를 실제 격리 런타임에 연결하는 로우레벨 adapter를 담당한다.
현재 이 폴더는 Linux 컨테이너 기반 network namespace holder runtime을 소유하고, macOS/Linux Borrowed Network runtime은 VS Code 터미널 native hook 주입 흐름에서 조립된다.

## 책임

- Docker/Podman 같은 Linux namespace holder 런타임 가용성 탐지
- extension 전역 bridge network 생성과 유지
- Logical Network별 network namespace holder container 생성
- 선택된 터미널이 host 환경을 유지한 채 holder network namespace만 빌릴 수 있는 attach 명령 생성
- Host Port Exposure가 연결할 holder container target 주소 확인
- 컨테이너리스 runtime과 공존할 수 있도록 capability descriptor 제공

## 주요 진입점

- `container-runtime.ts`

## 외부 의존성

- `child_process`
- Docker 또는 Podman CLI
- `src/shared`

## 주의사항

이 모듈은 VS Code UI를 직접 호출하지 않는다. Host Port Exposure를 위한 host listener는 `src/platform/ports`가 담당하고, 이 모듈은 holder network namespace target만 해석한다.
네트워크 생성 시 사용자는 Linux namespace runtime과 Borrowed Network native hook runtime 중 사용 가능한 선택지를 고른다. macOS에서는 Docker Desktop network namespace attach를 지원하지 않고 native hook runtime을 사용한다.
