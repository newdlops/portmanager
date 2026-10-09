# Core Networks

## 역할

Logical Network, Terminal Attachment, Host Port Exposure의 순수 도메인 상태를 관리한다.

## 책임

- Logical Network 생성과 삭제
- Terminal Attachment 상태 저장
- Host Port Exposure 상태 저장
- Network snapshot 생성
- 상태 변경 이벤트 발행
- logical route 후보를 작업 디렉터리 범위로 좁히는 순수 선택 로직
- hookless host-machine localhost 요청의 기본 gateway 후보 선택
- 브라우저 DNS의 관리자 권한 갱신 여부 판정: 별칭 → loopback 매핑과 root 소유 상태(lo0, resolver, hosts, TLS)가 실제로 어긋났을 때만 drift로 본다
- router 귀속 캐시의 PID/시작 시각 정체성, TTL과 실제 항목 상한 유지
- proxy 소유자들의 공통 자원 예산과 원자적 admission/lease 반환 정책

## 주요 진입점

- `logical-network-registry.ts`
- `logical-route-selection.ts`
- `host-default-gateway.ts`
- `browser-dns-drift.ts`
- `router-verdict-cache.ts`
- `proxy-resource-budget.ts`

## 외부 의존성

- `src/shared`

## 주의사항

이 모듈은 VS Code API, OS 프로세스 조회, socket bind, proxy 실행을 직접 수행하지 않는다.
런타임 동작은 extension 또는 platform 계층의 adapter가 수행하고, 이 모듈은 그 결과 상태만 반영한다.
시작 시각을 모르는 PID는 캐시하지 않는다. 상한 초과는 만료 항목 정리와 LRU
퇴출로 처리하며, cache hit는 attachment 변경을 관측할 TTL을 연장하지 않는다.
기본 TTL clock은 `performance.now()`다. 시스템 시계 역행으로 이전 네트워크
귀속이 더 오래 남지 않으며 테스트는 동일한 경과 시간 clock을 주입할 수 있다.
`proxy-resource-budget.ts`는 카운터 정책만 다루는 작은 단일 책임 파일이다.
socket·DNS·child process 수명은 platform에 두어 줄 수를 맞추기 위한 IO 의존이나
불필요한 추상화를 추가하지 않는다. 다중 자원 요청은 한 항목이라도 부족하면
어떤 카운터도 변경하지 않고, lease의 중복 반환은 추가 용량을 만들지 않는다.
