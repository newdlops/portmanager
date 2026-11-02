# Native Socket Hook

## 역할

터미널 프로세스의 소켓·exec 경계에서 논리 네트워크의 라우팅과 정체성을 제공한다.
기존 단일 interposition 소스의 플랫폼 초기화 순서를 유지하므로 파일 길이 기준의
예외로 관리한다.

## 책임

- bind/connect/getsockname과 프로세스 실행 경계의 투명한 네트워크 매핑
- 프로세스가 소유한 listener와 임시 sender 예약의 생명주기 구분
- 라우트 파일의 TTL·파일 정체성 검증 및 네트워크·방향·cwd·Compose 우선순위 유지
- 네트워크별 호스트명, 환경변수, 파일 치환

## 주요 진입점

- `portmanager_hook.c`: 생성자 및 OS별 interposition 등록
- `pm_load_route_file_routes`: bulk 호출자에게 독립적인 소유 스냅샷 반환
- `pm_route_table_lookup_file`: 파일 metadata/cwd 수집 뒤 mutex 안에서 immutable
  포트 인덱스의 일치 범위만 선택. warm 조회는 전체 배열 할당·복사를 하지 않는다.

## 외부 의존성

libc/POSIX, pthread, macOS dyld 또는 Linux preload, shared dev-log 및 network storage,
Port Manager agent의 Unix socket과 라우트 JSON 파일에 의존한다.

## 주의사항

라우트 캐시는 device/inode/size 및 nanosecond mtime/ctime으로 교체를 확인한다.
문서 expiry(legacy는 mtime TTL)와 최초 로드 때 계산한 monotonic deadline을 함께
검사하며, warm hit로 TTL을 갱신하지 않는다. 동일 metadata의 만료 항목은 eviction까지
유지해 wall-clock rollback 뒤 재로딩으로 수명이 늘어나지 않게 한다.

retained entry capacity·라우트 배열·양방향 stable 포트 인덱스의 합은 16MiB 이하다.
LRU 항목을 비워 슬롯을 재사용하고, 캐시보다 큰 문서는 기존 1MiB 입력 제한 안에서
uncached 스냅샷으로 처리한다. 파일 읽기·stat·cwd 조회는 선택 mutex 밖에서 수행한다.
읽는 동안 in-place 변경이 감지되면 불완전 스냅샷을 게시하지 않는다. 파일 refresh는
기존 연결을 닫거나 재시도하지 않는다.

검증: `test/unit/native-hook-route-cache.test.ts`, `native-hook-connect.test.ts`,
`native-hook-registration.test.ts`. 모든 fixture는 상속한 PM/preload 환경을 제거한다.

`native-agent-dns.test.ts`의 long-lived client 통합 사례는 실제 preload된 Node
프로세스 하나로 warm 조회 → explicit expiry의 새 연결 거부 → 동일 크기·mtime의
atomic 교체 → 새 backend 선택을 검증한다. 기존 TCP·HTTP chunk stream·SSE는
각 단계와 fixture DNS daemon 재시작 뒤에도 기존 backend에서 새 바이트를 받으며,
앞에 배치한 foreign-network sentinel은 연결을 받지 않는다. 파일·daemon·Unix/UDP/TCP
소켓은 모두 테스트 전용이며 시스템 DNS나 실행 중 사용자 daemon을 변경하지 않는다.

macOS arm64 측정에서 2,048행의 warm last-row 조회 2,000회는 5회 교대 실행의
중앙값 146.978ms → 45.942ms(약 3.2배)였다. 별도 계측은 warm 조회의 할당 0회·
정수 비교 56회와 16MiB retained 상한을 검증한다. 이는 metadata/cwd/clock을 포함한
lookup 마이크로벤치마크이며 연결 지연·처리량이나 모든 workload의 속도 보장이 아니다.
