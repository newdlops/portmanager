# Native Logical Router

## 역할

논리 포트의 loopback 연결을 소스 PID/시작 시각/네트워크에 귀속시키고 부모가
선택한 실제 target으로 TCP 바이트를 전달한다.

## 책임

- IPv4/IPv6 listener의 LISTEN/CLOSE 수명과 CLOSED 확인
- 프로세스 귀속 결과를 version 2 CONNECT control frame으로 전달
- 공유 TCP adapter의 worker/DNS 상한, 준비 기한, FIN/reset/backpressure 적용
- stdin/owner 종료 시 listener와 process 자원 회수

## 주요 진입점

- `portmanager_tcp_router.c`: `--control` 또는 단독 포트 CLI
- `../shared/pm_tcp_proxy.{h,c}`: transport/제어 출력의 제한된 수명
- `src/platform/ports/logical-port-router.ts`: TypeScript parent와 공통 예산

## 외부 의존성

POSIX socket/poll/pthread, Darwin kqueue, `pm_peer_process`, `pm_dev_log`.

## 주의사항

확장에서는 기본 worker 32개·DNS 작업 2개 용량을 부모 공통 예산에서 예약한다.
단독 CLI는 기본 256/4이며 OS fd 한도로 admission을 더 줄일 수 있다.
부모는 dual-stack LISTEN마다 listener 용량 2개를 예약하고 실제 CLOSED/실패/exit
확인 뒤 반환한다. CLOSE는 listener만 내려 기존 accepted stream을 보존한다.
한 포트의 reopen은 이전 CLOSE 확인 뒤 시작하므로 port-only 상태 답변이 새
예약을 해제하지 않는다. helper가 warm 상태로 남는 동안 worker/DNS 예약도 유지한다.
귀속 실패는 다른 네트워크를 추측하지 않고 부모 정책에서 fail-closed로 처리한다.
