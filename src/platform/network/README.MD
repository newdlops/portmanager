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
- macOS `getaddrinfo` 경로에서 각 브라우저 alias가 정확한 loopback 주소 하나로 해석되는지 검증
- daemon의 network/port route shard를 중복 디렉터리 조회 없이 읽고 유효한 fallback snapshot으로 반환
- 생성된 TLS leaf의 실제 SAN/CN이 모든 브라우저 hostname을 포함하는지 검증
- 생성된 브라우저 TLS leaf를 macOS 기본 Keychain search list로 실제 검증하고 짧게 캐시

## 주요 진입점

- `browser-dns-server.ts`
- `browser-dns-verifier.ts`
- `generated-route-table-reader.ts`
- `browser-tls-certificate.ts`
- `browser-tls-trust.ts`
- `container-runtime.ts`
- `container-service-discovery.ts`
- `container-events-watcher.ts`
- `compose-publish-mutator.ts`
- `shared-network-state-store.ts`

## 외부 의존성

- `child_process`
- Docker 또는 Podman CLI
- Docker Compose CLI
- `dgram`
- macOS system resolver (`getaddrinfo`)
- macOS `security verify-cert`
- `src/shared`

## 주의사항

이 모듈은 VS Code UI를 직접 호출하지 않는다. Host Port Exposure를 위한 host listener는 `src/platform/ports`가 담당하고, 이 모듈은 holder network namespace target만 해석한다.
네트워크 생성 시 사용자는 Linux namespace runtime과 Borrowed Network native hook runtime 중 사용 가능한 선택지를 고른다. macOS에서는 Docker Desktop network namespace attach를 지원하지 않고 native hook runtime을 사용한다.
Compose clone mutation은 원본 컨테이너의 실제 mount를 먼저 inspect해 generated override에 pin하고, 원본 project의 host-published 선택 서비스만 stop한 뒤 `docker compose -p <network-scoped-name> -f ... -f <generated override> up`으로 hidden clone을 만든다. 이미 실행 중인 내부 Compose 서비스는 hidden clone에도 함께 포함해 브로커/캐시 같은 no-port 의존성이 다른 네트워크나 원본 project로 새지 않도록 한다. 원본 project name으로 사용자가 다시 `docker compose up`을 실행할 수 있게 host publish port를 실제로 해제하기 위한 흐름이며, 원본과 hidden project가 같은 data volume을 동시에 mount하지 않도록 restore 때도 hidden 서비스를 먼저 stop한다. Attach as-is는 Compose lifecycle을 변경하지 않고 현재 published port를 logical network route로만 등록한다.
Logical Network의 durable 상태는 여러 VS Code 창이 동시에 읽고 갱신하므로 `shared-network-state-store.ts`의 globalStorage JSON 파일을 통해 공유한다. 창별 terminal/container discovery 결과는 transient 상태로 남기고, networks/attachments/exposures/host access/compose attachments만 공유 파일에 저장한다.
`container-service-discovery.ts`는 `container ls -a` 스냅샷 한 번에서 실행 상태와 중지된 원본의 Compose label을 함께 읽는다. `State`/`Status`를 해석할 수 없는 런타임만 실행 중 목록을 별도로 조회한다. 중지된 Compose 서비스는 attach 후보로 유지하되 live route에는 포함하지 않는다. 동일 런타임의 겹치는 조회는 진행 중인 Promise만 공유하며, 완료·실패 이후의 새 요청은 다시 읽어 재생성된 포트를 즉시 반영한다. 이름 복구용 inspect도 세션 안에서 진행 중·실패·누락 결과를 공유하고 다음 세션에서 다시 시도한다.
`container-events-watcher.ts`는 Docker에 라우팅 관련 `event=` 필터를 전달해 healthcheck·exec 잡음이 확장 호스트까지 전달되지 않게 한다. 동일 키의 여러 필터는 OR로 적용된다([Docker events 문서](https://docs.docker.com/reference/cli/docker/system/events/#filtering---filter)). Podman은 action 이름 차이 때문에 기존 type 필터와 로컬 파서를 유지한다. 이벤트 묶음 처리와 daemon 재연결 backoff는 watcher가 담당하며, 라우팅 반영 정책은 extension에 남는다.
이벤트 callback은 Promise 완료까지 직렬화하며 처리 도중 들어온 이벤트는 runtime/Compose project별로 합쳐 다음 한 번에 전달한다. metadata가 없는 이벤트와 256개를 초과하는 scope burst는 해당 runtime 전체의 변경으로 합친다. Docker의 `Actor.Attributes`와 Podman의 `Attributes`에서 Compose label을 읽고, Podman `died`는 `die`로 정규화한다. network connect/disconnect의 `Attributes.container`는 같은 batch의 container event ID와 연결해 project를 복구하고, 미확인 ID는 extension이 persisted container mapping으로 범위를 결정하게 전달한다. 정상 스트림이 끊겼다 복구되면 조용한 스트림이어도 누락 복구 callback을 즉시 예약한다. dispose 후 남은 batch는 버린다.
`browser-dns-server.ts`는 `/etc/resolver/<network-name>` 같은 OS resolver 설정이 이미 Port Manager DNS 포트를 바라볼 때만 브라우저 alias를 해석한다. 권한이 필요한 resolver 파일 설치는 이 어댑터가 직접 수행하지 않는다. Extension hosts publish immutable shared-state revision snapshots; the daemon accepts only a snapshot whose named document still carries that revision, preventing a delayed window from replacing current aliases.
`browser-tls-trust.ts`는 TreeView 렌더 경로에서 subprocess를 실행하지 않는다. 인증서 stat signature와 짧은 TTL의 마지막 결과만 동기적으로 반환하고, service가 비동기 `security verify-cert`를 수행한 뒤 UI를 갱신한다. 임의 CA를 검증 명령에 root로 주입하지 않아야 하며, 실제 기본 Keychain trust만 성공으로 인정한다.
`browser-dns-verifier.ts`는 `/etc/resolver` 파일 존재를 성공으로 간주하지 않고 macOS system resolver가 single-label과 `.pm` alias 모두를 정확한 주소로 반환할 때만 준비 완료로 판단한다. `browser-tls-certificate.ts`도 hostname marker와 별개로 실제 signed leaf를 검사한다.
`generated-route-table-reader.ts`는 생성 파일의 조회·파싱·변경 관찰을 담당하는 adapter다. 경로와 만료 유예 정책은 호출자가 주며, 폴더당 한 번 열거하고 최대 8개 파일을 병렬로 읽는다. snapshot reader는 파일 내용을 캐시하지 않고 network table → port shard 순서를 유지하며 손상·소실·만료된 파일 하나가 정상 파일까지 버리게 하지 않는다. `GeneratedRouteTableWatcher`만 파일별 관측을 보관한다. 이름이 알려진 이벤트는 변경 파일만 읽고, 초기화·이벤트 이름 누락·watch 재연결은 전체를 읽는다. 생성·교체·삭제를 50ms 고정 구간으로 합치고 라우팅 내용이 바뀔 때만 callback을 보낸다. heartbeat는 관측의 TTL만 갱신하며 만료 시각에 별도 wakeup으로 route 소실을 알린다. owner loss/dispose 뒤 늦게 끝난 읽기는 버린다. callback 뒤 실제 route 적용은 새 full snapshot으로 하며, 재동기화와 lease 판단은 extension에 남겨 둔다.
