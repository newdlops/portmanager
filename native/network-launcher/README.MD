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
- 시작 기한, 신호 전달, 실행별 커널 권한과 PID 세대로 확인한 자손의 종료 관리

## 주요 진입점

`portmanager_network_launch.c`:

```text
--profile <private SBPL file> --broker <fixed Unix endpoint>
--hook <protected dylib> --network-id <stable id>
[--agent-socket <agent endpoint> --controller-token-file <private key>]
[--ready-file <private session record>]
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

`--ready-file`은 controller 옵션과 함께 사용한다. 대상은 보호된
`.portmanager/security/sessions/` 아래의 아직 없는 파일이어야 한다. 부모 descriptor를
nofollow로 확인한 뒤 정책·PID 승인·exec EOF가 모두 성공하면 supervisor만 private
0600 JSON을 atomic no-replace로 게시한다. 앱은 writer/directory FD를 상속하지 않는다.
기존 파일·symlink·공개 parent는 exec 전에 거부하고 종료 시 같은 inode만 삭제한다.

```json
{"supervisorPid":123,"supervisorBirth":1791500000000000,"pid":124,"birth":1791500000000010,"networkId":"network-a"}
```

소비자는 알려진 PTY supervisor PID와 독립적으로 조회한 두 PID의 OS birth를 대조한다.
stdout 문구는 승인 채널로 사용하지 않는다. ready parent descriptor 하나가 종료까지
유지되며, 재등록 controller FD 하나와 함께 helper FD 예산에 포함해야 한다.

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

`pm_network_launch_members.h`는 실행마다 128-bit 임의 이름의 private 표식 파일을 만들고
그 파일의 읽기만 정책에 추가한다. 내용은 고정 문자열이며 제어 권한·키·명령을 담지
않는다. 이미 거절되는 profile 경로와 함께 실제 kernel permission을 조회하므로, 부모가
관측 전에 종료된 setsid/double-fork 자손도 같은 실행으로 식별한다. env·argv·PPID·PGID를
회수 권한으로 사용하지 않는다. 표식 writer와 parent FD는 프로그램에 상속하지 않는다.

회수 신호는 public `task_name_for_pid`/`TASK_AUDIT_TOKEN`으로 얻은 PID 세대에 묶고,
소속 조회 앞뒤의 audit token이 같을 때만 `proc_signal_with_audittoken`을 호출한다.
커널이 오래된 PID 세대를 거절하므로 PID-only 확인 후 kill하는 사이의 재사용을 피한다.
직접 만든 아직 reap하지 않은 root에 대한 초기 종료 외에는 숫자 PID/group 신호로
fallback하지 않는다. OS 신호 API/권한 조회가 없으면 프로그램 시작을 거절한다.

root 종료는 전체 종료 확인이 아니다. 살아 있는 소속 프로세스를 회수하며 최대 16,384개
PID의 완전한 목록을 두 번 비교하고, 두 번 모두 소속 프로세스가 없고 목록 정체성이
안정되어야 supervisor가 반환한다. 외부 보호 프로세스·이미 사라진 PID는 소속으로
추정하지 않으며 census에 자리만 보존한다. 알 수 없는 소속, 목록 잘림과 fork churn은
성공으로 처리하지 않는다. 확인 중에는 supervisor·TTY·표식이 유지된다.

표식 parent FD 하나가 실행 중 추가로 유지된다. 종료 확인에만 PID buffer 65,536 bytes와
identity buffer 두 개 524,288 bytes(합계 589,824 bytes)를 할당한다. 완료 뒤 같은 표식
inode만 삭제하고 모든 buffer/FD를 반환한다. 다른 터미널/호스트 프로세스와 PID 세대
불일치가 신호 대상이 되지 않는지는 실제 disposable 프로세스로 검증한다.

## 종료 증명과 감독자 복구

제품 소비자는 실행 전에 `--lifecycle-version`의 출력 `1`과 성공 종료를 확인한다.
이 버전에서 `--ready-file <path>`를 사용하면 guard에 exec ACK를 보내기 전에
`<path>.owner`를 게시한다. 소유 기록은 2048 bytes 미만의 private 0600 single-link
JSON이며 supervisor와 child의 PID/birth, network ID, profile·표식 경로와 표식
device/inode를 담는다. 준비 실패에는 앱을 실행하지 않는다. 임의 stdout이나 부모
PID의 소멸은 실행 승인 또는 회수 완료의 증거가 아니다.

```json
{"version":1,"supervisorPid":123,"supervisorBirth":1791500000000000,"pid":124,"birth":1791500000000010,"networkId":"network-a","markerPath":"/workspace/.portmanager/security/profiles/.scope-example","profilePath":"/workspace/.portmanager/security/profiles/example.sb","markerDev":1,"markerIno":42}
```

두 번의 안정된 kernel membership census로 모든 소속 프로세스의 종료를 확인한 뒤에만
`<path>.cleaned`를 원자 게시한다. 이 파일은 같은 canonical 소유 기록에 `cleaned: true`
필드만 추가하며 2080 bytes 미만이다. 소비자는 파일의 private parent/owner/mode/nlink,
launch tuple과 표식 정체성까지 대조한 뒤 lease를 해제한다. 완료 기록 게시가 실패하면
supervisor는 자원 소유권을 유지하고 재시도한다. 기록·표식·profile을 먼저 삭제하지 않는다.
owner와 완료 기록의 최종 삭제는 확인을 마친 trusted 소비자의 책임이다.

감독자가 갑자기 종료되면 `--recover-owner <path>.owner`로 복구한다. 아직 같은 PID/birth의
감독자가 살아 있으면 내부 `EBUSY`로 거절한다. owner·표식·profile의 private 경로와 파일
정체성을 확인한 뒤 같은 census와 audit-token 신호를 사용해 남은 소속 프로세스를 회수한다.
정확히 일치하는 기존 완료 기록은 반복 호출에 사용할 수 있다. 새 회수도 완료 기록 게시
후에만 `{"cleaned":true,"version":1}`을 출력하고 exit 0을 반환한다. 잘못된 CLI 경로 형식은
exit 2, 검증·지원 API·게시 실패나 중단은 exit 125이며 성공 JSON을 출력하지 않는다.
실패 또는 호출자 timeout만으로 lease를 해제해서는 안 된다. TERM/INT/HUP은 확인 대기를
중단하지만 미확인 표식과 소유 기록은 남긴다. 회수에 성공하는 고정 시간 제한은 없다.

v1 확인 후 부모가 exec ACK 전에 죽고 owner도 없으면 앱 실행은 승인되지 않았다.
guard는 private ACK channel의 EOF에 종료한다. 이 경우 private ready가 나타난다면
계약 위반으로 취급해 소유권을 유지한다. 오래된 binary의 owner 부재는 이 증거가 아니다.
owner가 있으면 시작 도중의 죽음도 복구 경로로 확인한다. 회수 helper는 같은
589,824-byte census peak와 표식 parent FD 하나를 사용한다. owner/완료 파일의 IO FD는
짧게 열고 닫으며 workload에 상속하지 않는다.

## 외부 의존성

macOS `sandbox-exec`, libproc, POSIX fork/exec/pipes/poll/process groups,
`native/network-broker/pm_network_broker_client.h`, 공유 `pm_agent_scope_client.h`와
`pm_dev_log.c`, agent JSON codec `portmanager_agent_json.c`.

## 상태와 주의사항

새 실행 후보이며 아직 제품 attach/packaging에 연결하지 않았다. guard probe는
커널 적용과 broker transport의 시작 확인이며, 생성된 profile 전체의 보안 검증을
대체하지 않는다. 정책 생성은 trusted controller의 책임이다.
PID 등록과 controller-origin ancestry 조회 및 parent 전용 readiness 파일은 native API에
연결했다. 실제 terminal 소비자, shell bootstrap과 SIP preload 복구,
DNS/host access 및 공유 resource-budget 통합은 별도 연결해야 한다. 관측된 자손은
reparent 뒤에도 birth에 묶어 기억한다. 관측 전 orphan은 고정 broker가 실제 peer를
등록하며, 데몬 재시작 뒤 idle 자식은 supervisor가 재등록한다. 실제 합성 커널 실행에서
두 복구 경로와 pending 재등록 중 종료를 검증한다.
native route 복구와 확장 proxy 귀속은 API 사용을 연결했다. proxy는 현재 OS birth와
scope tuple을 확인한 뒤에만 network로 분류하며, 조회 실패·불일치에 env/cache/tracker로
대체하지 않는다. 미등록 host process는 env에서 network를 만들지 않는 host 정책에
남는다. 이 메커니즘을 실제 제품 terminal attach에 연결한 검증은 남아 있다.
Linux 및 다른 macOS 버전의 실행 지원은 확인하지 않았다.
