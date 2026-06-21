# Platform Network

## 역할

Logical Network를 실제 격리 런타임에 연결하는 로우레벨 adapter를 담당한다.

## 책임

- Docker/Podman 같은 컨테이너 런타임 가용성 탐지
- Logical Network별 bridge network와 long-running container 생성
- 선택된 터미널이 컨테이너 내부 shell로 진입할 수 있는 명령 생성
- Host Port Exposure가 연결할 컨테이너 target 주소 확인

## 주요 진입점

- `container-runtime.ts`

## 외부 의존성

- `child_process`
- Docker 또는 Podman CLI
- `src/shared`

## 주의사항

이 모듈은 VS Code UI를 직접 호출하지 않는다. Host Port Exposure를 위한 host listener는 `src/platform/ports`가 담당하고, 이 모듈은 컨테이너 내부 target만 해석한다.
