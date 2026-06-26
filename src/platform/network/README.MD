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
- Docker Compose clone attach 시 published port를 hidden localhost publish로 바꾼 network-scoped clone 생성과 원본 서비스 stop/restore
- 컨테이너리스 runtime과 공존할 수 있도록 capability descriptor 제공
- 브라우저용 network-name alias를 loopback 주소로 해석하는 로컬 DNS responder 실행

## 주요 진입점

- `browser-dns-server.ts`
- `container-runtime.ts`
- `container-service-discovery.ts`
- `compose-publish-mutator.ts`
- `shared-network-state-store.ts`

## 외부 의존성

- `child_process`
- Docker 또는 Podman CLI
- Docker Compose CLI
- `dgram`
- `src/shared`

## 주의사항

이 모듈은 VS Code UI를 직접 호출하지 않는다. Host Port Exposure를 위한 host listener는 `src/platform/ports`가 담당하고, 이 모듈은 holder network namespace target만 해석한다.
네트워크 생성 시 사용자는 Linux namespace runtime과 Borrowed Network native hook runtime 중 사용 가능한 선택지를 고른다. macOS에서는 Docker Desktop network namespace attach를 지원하지 않고 native hook runtime을 사용한다.
Compose clone mutation은 원본 컨테이너의 실제 mount를 먼저 inspect해 generated override에 pin하고, 원본 project의 선택 서비스를 stop한 뒤 `docker compose -p <network-scoped-name> -f ... -f <generated override> up`으로 hidden clone을 만든다. 원본 project name으로 사용자가 다시 `docker compose up`을 실행할 수 있게 host publish port를 실제로 해제하기 위한 흐름이며, 원본과 hidden project가 같은 data volume을 동시에 mount하지 않도록 restore 때도 hidden 서비스를 먼저 stop한다. Attach as-is는 Compose lifecycle을 변경하지 않고 현재 published port를 logical network route로만 등록한다.
Logical Network의 durable 상태는 여러 VS Code 창이 동시에 읽고 갱신하므로 `shared-network-state-store.ts`의 globalStorage JSON 파일을 통해 공유한다. 창별 terminal/container discovery 결과는 transient 상태로 남기고, networks/attachments/exposures/host access/compose attachments만 공유 파일에 저장한다.
`browser-dns-server.ts`는 `/etc/resolver/<network-name>` 같은 OS resolver 설정이 이미 Port Manager DNS 포트를 바라볼 때만 브라우저 alias를 해석한다. 권한이 필요한 resolver 파일 설치는 이 어댑터가 직접 수행하지 않는다.
