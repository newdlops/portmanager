# Port Manager Optimization Notes

## 목적

Port Manager extension은 개발 서버를 논리 포트와 네트워크 별칭 뒤에 숨겨 주는 가벼운 reverse proxy 역할을 한다. nginx처럼 빠른 반응성을 목표로 할 때는 요청 처리 경로에서 제어면 비용을 제거하고, route 결정과 socket forwarding을 더 예측 가능한 data plane으로 분리해야 한다.

이 문서는 2026-06-29 기준 읽기 전용 코드 탐색 결과를 정리한다. 코드 수정 없이 `browser-network-proxy`, logical/host TCP router, native hook/agent, route table, snapshot/sync 경로를 확인했다.

## 핵심 결론

현재 구조는 기능적으로 reverse proxy에 가깝지만 nginx식 고성능 프록시 구조는 아니다.

- HTTP browser proxy는 Node.js HTTP server 위에서 동작하며 요청마다 target resolve, upstream request 생성, header rewrite를 수행한다.
- native TCP helper는 payload 복사를 C로 옮겼지만, 연결마다 TypeScript control-plane에 route를 질의한다.
- native hook은 in-process route cache hit일 때 빠르지만, cache miss에서는 route table 파일을 열고 JSON 문자열을 스캔한다.
- snapshot, listener scan, route table write 같은 제어면 작업 일부가 요청 또는 route 변경 경로와 섞여 있다.

## 요청 핫패스

### Browser HTTP Proxy

주요 경로:

- `src/platform/ports/browser-network-proxy.ts`
  - `BrowserNetworkProxyManager.open`
  - `forwardHttp`
  - `forwardUpgrade`
- `src/extension/network-service.ts`
  - `resolveBrowserNetworkProxyTarget`
  - `findNetworkRoute`
  - `findBrowserProxyFallbackListenerTarget`

현재 HTTP 요청은 다음 순서로 처리된다.

1. browser-facing HTTP server가 요청을 받는다.
2. `targetResolver.resolve(endpoint)`로 현재 upstream target을 찾는다.
3. `http.request()`로 upstream 요청을 새로 만든다.
4. request header를 localhost 기준으로 rewrite한다.
5. upstream response header를 browser alias 기준으로 rewrite한다.
6. response body는 stream pipe로 전달한다.

비용이 큰 지점:

- `forwardHttp`와 `forwardUpgrade`가 요청마다 resolver를 await한다.
- 정상 route lookup은 snapshot 메모리 배열 탐색이지만, route miss 시 `processService.refresh()`까지 갈 수 있다.
- fallback path는 listener 목록을 돌며 PID별 environment/command 정보를 읽을 수 있다.
- upstream `http.Agent`/keep-alive pool이 명시적으로 관리되지 않는다.
- response header rewrite가 모든 header value를 훑고 `replaceAll`, cookie split/filter/join을 수행한다.

### Logical/Host TCP Router

주요 경로:

- `src/platform/ports/logical-port-router.ts`
- `src/platform/ports/host-port-proxy.ts`
- `native/router/portmanager_tcp_router.c`
- `native/host-exposure/portmanager_host_exposure_proxy.c`

현재 native helper 경로는 다음 구조다.

1. C helper가 socket을 accept한다.
2. helper가 stdout protocol로 TypeScript 쪽에 `CONNECT` 질의를 보낸다.
3. TypeScript resolver가 route를 선택하고 stdin protocol로 `ROUTE`를 응답한다.
4. C helper가 target에 connect한다.
5. 연결마다 connection thread 1개와 양방향 copy thread 2개가 생긴다.

비용이 큰 지점:

- payload 복사는 C에서 하지만 첫 byte 지연은 route resolve 왕복이 지배할 수 있다.
- helper는 nginx처럼 event-loop 기반 nonblocking proxy가 아니라 pthread-per-connection 모델이다.
- route 응답이 오지 않으면 native connection thread가 조건변수에서 대기한다.
- host exposure처럼 target이 거의 고정인 경우에도 연결마다 `CONNECT -> ROUTE` 왕복이 발생한다.

### Native Hook

주요 경로:

- `native/hook/portmanager_hook.c`
- `native/agent/portmanager_agent_state.c`
- `src/agent/route-table.ts`

`connect()` 경로는 대략 다음 순서다.

1. in-process `pm_routes` memory cache 조회
2. per-port route-entry file 조회
3. scoped route table file 조회
4. compose claim file 조회
5. host-access file 조회
6. loopback alias 직접 connect
7. sender-first daemon allocation

비용이 큰 지점:

- 최선 경로인 `pm_routes`도 배열 선형 탐색이다.
- route table miss/hit 파일 경로는 `open -> fstat -> malloc -> read -> JSON 문자열 scan -> free`다.
- JSON parser가 아니라 `strstr`, `strchr`, `atoi` 기반 반복 검색이다.
- `pm_wait_for_route`는 50ms 단위 polling으로 기본 network route 1초, compose route 10초까지 기다릴 수 있다.
- bind high-port 경로는 보통 `allocateRoute` IPC, 실제 bind, `registerExistingProcess` IPC가 붙는다.

## 제어면 비용

### Snapshot과 Route Table Write

주요 경로:

- `src/agent/port-manager-agent.ts`
  - `buildSnapshot`
  - `queueSnapshotBroadcast`
  - `writeRouteTable`
- `native/agent/portmanager_agent_state.c`
  - `pm_write_route_tables`
  - `pm_flush_route_tables_for_allocation`

확인한 내용:

- snapshot debounce와 signature 비교는 이미 있다.
- 하지만 `buildSnapshot()`이 listener scan, hook route recovery, cleanup, route table write를 포함한다.
- route table write는 sync FS lock, generation read, 여러 JSON file write/remove로 구성된다.
- native agent는 `compactResponse`일 때 per-endpoint file을 먼저 쓰고 aggregate table은 나중으로 미루는 최적화가 있다.

문제:

- snapshot은 read model이어야 하는데 route table publish까지 포함한다.
- route table write가 UI refresh, command refresh, route mutation 경로에 섞이면 p99가 튈 수 있다.
- Node fallback agent의 route table writer는 native agent의 per-endpoint fast path와 완전히 같은 수준으로 최적화되어 있지 않다.

### Browser Proxy Sync

주요 경로:

- `src/extension/network-service.ts`
  - `syncBrowserNetworkProxies`
  - `syncBrowserNetworkProxiesExclusive`
  - `readBrowserProxyProcessCommandTexts`
  - `collectBrowserProxyEndpoints`

확인한 내용:

- HTTP 요청마다 실행되지는 않는다.
- in-flight/queued guard는 있다.
- sync마다 owner lease 파일을 확인하고, 일부 process에 대해 command text를 다시 읽는다.
- `readRoutingNetworkId`에는 PID cache가 있지만 command text read에는 별도 TTL cache가 없다.

문제:

- process/network 수가 많으면 sync가 extension host 반응성에 영향을 줄 수 있다.
- endpoint signature가 동일한데도 command read, owner lease 갱신, proxy sync가 반복될 수 있다.

## 개선 우선순위

### P0. Browser Proxy Target Cache와 Keep-Alive

목표:

- 요청마다 route resolve와 refresh를 하지 않는다.
- upstream TCP connection을 재사용한다.

방향:

- snapshot/sync 시 `(networkId, logicalPort) -> { host, port }` 메모리 인덱스를 갱신한다.
- `forwardHttp`에서는 Map lookup만 수행한다.
- miss는 즉시 502 또는 stale target 사용 후 background refresh로 처리한다.
- endpoint/target별 `http.Agent({ keepAlive: true, maxSockets, maxFreeSockets })`를 명시한다.
- route target 변경 시 해당 agent pool을 정리한다.

기대 효과:

- browser asset 다량 요청에서 TCP connect 수, event-loop delay, p95/p99 latency 감소.

### P0. Native Hook Route Cache

목표:

- 반복 connect에서 파일 IO와 JSON scan을 제거한다.

방향:

- route table, host-access, compose-claim 파일에 `path + mtime + size` 기반 read-through cache를 둔다.
- parsed result를 `(networkId, logicalPort)`와 `(networkId, actualPort)` 기준으로 인덱싱한다.
- route table hit 결과를 `pm_routes` memory cache로 promote한다.
- `pm_routes` 배열 선형 탐색을 hash index나 bounded direct map으로 바꾼다.

기대 효과:

- hook이 걸린 개발 프로세스의 local connect latency가 안정된다.
- 파일 시스템 상태에 따른 tail latency가 줄어든다.

### P1. Snapshot과 Route Publish 분리

목표:

- snapshot refresh가 route table write를 유발하지 않게 한다.

방향:

- `buildSnapshot()`에서 `writeRouteTable(snapshot.routes)`를 제거한다.
- route table publish는 route-state mutation 전용 writer로 분리한다.
- route mutation이 아닌 UI refresh/listSnapshot은 route table을 건드리지 않는다.
- Node agent fallback writer도 native agent의 compact per-endpoint publish 전략과 맞춘다.

기대 효과:

- UI refresh와 background snapshot이 data/control path latency를 흔들지 않는다.

### P1. Native TCP Router Resolve Cache

목표:

- native helper의 per-connection TypeScript roundtrip을 줄인다.

방향:

- host exposure는 대부분 target이 고정이므로 open 시 target을 helper에 전달하거나 route 변경 시 push update한다.
- logical router는 route 후보가 단일한 경우 client PID lookup 전 fast path를 둔다.
- `(logicalPort, clientPid/network)` 단기 cache를 둔다.
- native route wait에 timeout과 cleanup을 명확히 둔다.

기대 효과:

- first-byte latency와 연결 burst 안정성이 개선된다.

### P1. Browser Proxy Header Rewrite 최적화

목표:

- HTTP response header rewrite allocation을 줄인다.

방향:

- endpoint별 `publicOrigin`, `upstreamOrigin`, localhost variants, host header를 precompute한다.
- `Location`, `Content-Location`, `Refresh`, `Access-Control-Allow-Origin`, `Link`, `Set-Cookie`처럼 rewrite 가능성이 높은 header 중심으로 처리한다.
- 나머지는 `includes` guard 후 필요한 경우에만 rewrite한다.
- `Set-Cookie` domain strip도 fast path를 둔다.

기대 효과:

- 작은 asset 요청이 많은 Vite/Next 환경에서 CPU와 allocation 감소.

### P2. Native Data Plane Event Loop화

목표:

- nginx에 가까운 socket forwarding 구조로 이동한다.

방향:

- pthread-per-connection 모델을 nonblocking sockets + `poll`/`kqueue`/`epoll` 기반 event loop로 바꾼다.
- write buffer watermark와 connect timeout을 둔다.
- pending route lookup은 O(n) linked list 대신 hash/ring map으로 바꾼다.

기대 효과:

- 대량 동시 연결에서 thread 수와 context switch 비용 감소.

## 벤치마크 계획

기준 비교:

- direct upstream
- browser proxy 경유
- logical TCP router 경유
- native hook route 경유

측정 항목:

- RPS
- p50, p95, p99 latency
- first-byte latency
- CPU 사용률
- event-loop delay
- heap allocation과 GC
- upstream TCP connect 수
- keep-alive hit rate
- TIME_WAIT 수
- route hit/miss/fallback 별 latency
- `processService.refresh()` 호출 횟수
- route table file read/write 횟수
- WebSocket handshake latency와 echo RTT

시나리오:

- 1000개 작은 static asset 요청
- JSON API 짧은 요청 burst
- 큰 response stream
- upload stream
- WebSocket 장시간 연결
- route target 변경 중 요청
- 많은 network/process가 있는 상태에서 browser proxy sync와 요청 동시 발생
- native hook memory cache hit, file cache hit, cold file read, daemon allocation 각각 측정

## 권장 실행 순서

1. browser proxy target Map cache와 keep-alive agent 추가
2. native hook route table parsed cache 추가
3. snapshot read model과 route table writer 분리
4. browser proxy sync signature skip과 command TTL cache 추가
5. native helper route push/cache 도입
6. native data plane event-loop화 검토

첫 두 작업이 가장 체감 가능성이 높다. 이후 작업은 p99 안정성과 대량 동시 연결 내성을 높이는 쪽이다.
