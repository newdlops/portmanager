# Native Container Mutation

## 역할

Compose attach 중 생성된 원본 컨테이너와 hidden clone 컨테이너의 매핑을 저수준 helper로 조회한다.

## 책임

- extension이 작성한 compose/container routing TSV를 읽는다.
- 현재 logical network와 runtime에 맞는 container mapping row만 선택한다.
- Docker/Podman CLI 인자의 컨테이너 id prefix, 전체 id, 컨테이너 이름, `container:/path` 형식을 clone 컨테이너 id로 변환한다.
- 매핑이 없거나 여러 개면 아무 출력 없이 실패한다.

## 주요 진입점

- `portmanager_container_map.c`

## 외부 의존성

- POSIX 파일 I/O
- 표준 C 런타임

## 주의사항

이 helper는 Compose YAML 생성, 서비스 선택, 컨테이너 lifecycle, rollback을 처리하지 않는다. 그 정책은 TypeScript의 `compose-publish-mutator.ts`와 shell wrapper에 남기고, native helper는 TSV 기반 container token 변환만 담당한다.
