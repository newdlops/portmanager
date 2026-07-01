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

## 주요 진입점

- `logical-network-registry.ts`
- `logical-route-selection.ts`
- `host-default-gateway.ts`

## 외부 의존성

- `src/shared`

## 주의사항

이 모듈은 VS Code API, OS 프로세스 조회, socket bind, proxy 실행을 직접 수행하지 않는다.
런타임 동작은 extension 또는 platform 계층의 adapter가 수행하고, 이 모듈은 그 결과 상태만 반영한다.
