# Network Workload Launcher

## 역할

호스트 파일·언어 런타임을 유지하는 macOS 실행 경로에서, 커널 정책 적용 확인과
실제 exec 사이의 경계를 감독한다. 부모 supervisor는 프로그램 하나만 시작하며
workload가 임의 명령·PID·network id를 보내는 관리 프로토콜은 제공하지 않는다.

## 책임

- 보호된 runtime의 launcher/hook 및 private profile을 descriptor로 확인
- 상속된 nonstandard FD와 이전 네트워크/preload 환경을 정리
- 실제 macOS 정책에서 private profile 읽기와 raw TCP connect가 거절됨을 확인
- 고정 범위 broker가 승인한 socket만 받아 transport 준비 확인
- 별도 socketpair의 고정 크기 record와 exec의 CLOEXEC EOF로 시작 결과 확인
- 선택한 controller 연결이 실제 fork PID·생성 시각을 등록하기 전까지 guard 대기
- 실행 중인 자식의 scope를 주기적으로 재등록해 교체된 데몬에서도 idle 프로세스 귀속 복구
- 시작 기한, 신호 전달, 소유한 PID/birth/process group의 종료 관리

## 주요 진입점

`portmanager_network_launch.c`:

```text
--profile <private SBPL file> --broker <fixed Unix endpoint>
--hook <protected dylib> --network-id <stable id>
[--agent-socket <agent endpoint> --controller-token-file <private key>]
[--announce-ready] -- <program> <args...>
```

profile은 `.portmanager/security/profiles/`, 실행 파일과 hook은
`.portmanager/runtime/` 아래에 둔다. profile은 private regular file이며 symlink와
hardlink를 거부한다. 로드한 profile 바이트를 sandbox-exec에 전달해 다시 읽는 경합을
피한다. guard의 socket은 exec 성공 시 닫히고 애플리케이션에 상속되지 않는다.
FD inventory는 정책 적용 전에만 사용한다. 프로그램 교체는 macOS의
`POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT`와 표준 IO의 명시적 상속으로
처리해, guard 안에서 process-info 권한을 추가로 허용하지 않는다.
기존 커널 정책을 해제하거나 다른 네트워크로 완화하는 기능은 없다.

controller 옵션은 쌍으로 지정한다. guard가 정책 적용을 확인하면 부모가 직접 생성한
PID·birth·고정 network id를 `registerProcessScope`로 등록하고 응답의 method/id/ok 및
동일 tuple을 확인한다. 이 확인 후 private ACK를 보내야 guard가 프로그램을 실행한다.
controller 키 읽기와 RPC FD 생성은 fork 이후 부모에서만 일어나며 workload에는
키와 FD가 전달되지 않는다. 부분·잘못된 응답, 거절, 원래 시작 기한 8초, 시작 중 취소는
프로그램 실행과 readiness 없이 종료한다. controller 없이 쓰는 경로는 독립적인 커널
검증용 후보다. 제품 연결에는 native daemon의 `authenticatesProcessScopes: true`와
controller 옵션과 daemon의 `--trusted-tools`가 필요하다. mutable PATH로 조회하는
daemon은 scope 승인을 거절해 프로그램 실행을 허용하지 않는다.

실행 중 supervisor는 1초 간격으로 실제 소유한 자식의 동일 tuple을 다시 등록한다.
한 번에 controller FD 하나와 2048-byte 요청/응답 buffer만 사용하며, 각 시도는 8초
기한의 nonblocking poll로 처리한다. 지연·거절·접속 실패 후 재시도하며 job control과
종료를 막지 않는다. 데몬 부재에도 적용된 커널 정책은 유지되고, broker의 각 TCP 작업은
별도로 새 승인을 요구한다. 자식 종료나 중지 시작 시 pending controller FD를 닫는다.

실제 TTY에서는 trusted parent의 stdin device만 정책에 추가한다. 다른 `/dev/tty*`
읽기는 기본 host-read allowlist에서 제외하며, `/dev/tty`는 해당 세션의 kernel alias다.
셸은 자기·자식에게만 신호를 보내고 자기 scheduling만 조정할 수 있다. 다른 sandbox의
프로세스 신호·우선순위와 다른 TTY의 접근은 합성 프로세스/PTY로 별도 검증한다.

## 외부 의존성

macOS `sandbox-exec`, libproc, POSIX fork/exec/pipes/poll/process groups,
`native/network-broker/pm_network_broker_client.h`, 공유 `pm_agent_scope_client.h`와
`pm_dev_log.c`, agent JSON codec `portmanager_agent_json.c`.

## 상태와 주의사항

새 실행 후보이며 아직 제품 attach/packaging에 연결하지 않았다. guard probe는
커널 적용과 broker transport의 시작 확인이며, 생성된 profile 전체의 보안 검증을
대체하지 않는다. 정책 생성은 trusted controller의 책임이다.
PID 등록과 controller-origin ancestry 조회는 별도 agent API에 연결했다. 실제 terminal
readiness 전달, shell bootstrap과 SIP preload 복구,
DNS/host access 및 공유 resource-budget 통합은 별도 연결해야 한다. 관측된 자손은
reparent 뒤에도 birth에 묶어 기억한다. 관측 전 orphan은 고정 broker가 실제 peer를
등록하며, 데몬 재시작 뒤 idle 자식은 supervisor가 재등록한다. 실제 합성 커널 실행에서
두 복구 경로와 pending 재등록 중 종료를 검증한다.
native route 복구와 확장 proxy 귀속은 API 사용을 연결했다. proxy는 현재 OS birth와
scope tuple을 확인한 뒤에만 network로 분류하며, 조회 실패·불일치에 env/cache/tracker로
대체하지 않는다. 미등록 host process는 env에서 network를 만들지 않는 host 정책에
남는다. 이 메커니즘을 실제 제품 terminal attach에 연결한 검증은 남아 있다.
Linux 및 다른 macOS 버전의 실행 지원은 확인하지 않았다.
