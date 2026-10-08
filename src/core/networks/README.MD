# Core Networks

## 역할

Logical Network, Terminal Attachment, Host Port Exposure의 순수 도메인 상태를 관리한다.

## 책임

- Logical Network 생성과 삭제
- 세 loopback 주소 대역의 충돌 검사와 재시도 할당, 저장 상태 적용 전 검증
- 표시 이름과 파일시스템 정규화에 영향을 받지 않는 ID 기반 namespace key
- Terminal Attachment 상태 저장
- Host Port Exposure 상태 저장
- Network snapshot 생성
- 상태 변경 이벤트 발행
- logical route 후보를 작업 디렉터리 범위로 좁히는 순수 선택 로직
- hookless host-machine localhost 요청의 기본 gateway 후보 선택
- 브라우저 DNS의 관리자 권한 갱신 여부 판정: 별칭 → loopback 매핑과 root 소유 상태(lo0, resolver, hosts, TLS)가 실제로 어긋났을 때만 drift로 본다

## 주요 진입점

- `logical-network-registry.ts`
- `loopback-address.ts`
- `network-identity.ts`: UTF-8 ID를 lowercase hex로 인코딩; native namespace header와 동일 규약
- `logical-route-selection.ts`
- `host-default-gateway.ts`
- `browser-dns-drift.ts`

## 외부 의존성

- `src/shared`

## 주의사항

이 모듈은 VS Code API, OS 프로세스 조회, socket bind, proxy 실행을 직접 수행하지 않는다.
런타임 동작은 extension 또는 platform 계층의 adapter가 수행하고, 이 모듈은 그 결과 상태만 반영한다.
