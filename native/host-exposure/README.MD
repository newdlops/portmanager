# Host Exposure Native Helper

## 역할

Host Port Exposure의 TCP accept/connect/byte-copy 데이터 plane을 실행한다.

## 책임

- 지정된 host address와 host port에 TCP listener를 연다.
- 연결마다 TypeScript control plane에 target 조회를 요청한다.
- 조회된 target host/port로 TCP 연결을 열고 양방향 byte stream을 전달한다.
- bind 실패, target 조회 실패, socket 오류는 개별 listener 또는 연결 실패로 한정한다.

## 주요 진입점

- `portmanager_host_exposure_proxy.c`

## 외부 의존성

- POSIX socket API
- `pthread`
- stdin/stdout control protocol

## 주의사항

이 helper는 Host Port Exposure 전용이다. 노출 row의 생성, 중복 검사, target 결정, registry 상태 변경은 TypeScript 계층이 계속 담당한다. helper가 없거나 시작에 실패하면 기존 Node.js proxy가 fallback으로 사용된다.
