# Network Socket Broker

## 역할

호스트 런타임을 그대로 사용하는 macOS 커널 격리 경로의 TCP 작업을 중개한다.
실행 시 정한 network id와 loopback 주소는 프로세스 수명 동안 고정된다. 요청에는
network id, PID, 파일 경로, 실행 명령 또는 agent 관리 method가 없다.

## 책임

- 실제 Unix peer UID/PID와 kernel 생성 시각 확인
- controller가 broker 자신의 PID·birth와 실제 요청자 PID·birth를 고정 network id로 승인한 뒤 TCP 작업 수행
- localhost/wildcard를 고정된 네트워크 loopback으로 바인드·연결
- 다른 loopback alias와 호스트 인터페이스 연결 거부
- TCP socket FD의 type/local endpoint 확인과 bind/connect/listen/accept 중개
- SCM_RIGHTS를 통한 기존 FD 공유와 새 socket/accept FD 전달
- client·FD·frame·기한·취소·종료 수명 제한

## 주요 진입점

- `portmanager_network_broker.c`: nonblocking poll 서버와 고정 범위 정책
- `pm_network_broker_protocol.h`: 160-byte request와 148-byte response 형식
- `pm_network_broker_client.h`: 기한 있는 Unix transport와 FD 수신 검증

서버는 동시에 64개 client를 받는다. slot은 control/받은 TCP/승인 RPC 또는 accept 결과
FD를 각각 최대 하나씩 소유한다. 승인 FD와 accept 결과 FD는 서로 다른 phase에서만
존재하므로 retained 한도는 slot당 3개다. 각 요청은 최초 accept에서 8초 후 만료한다. deadline은 부분
프레임·재시도로 늘어나지 않는다. connection 대기와 blocking accept는 poll로 처리하며
원래 nonblocking 호출은 EINPROGRESS/EAGAIN을 유지한다. 취소·만료·shutdown은 소유한
모든 복사본/미전달 FD를 닫고, 잠시 변경한 원래 socket flags를 복원한다.

`--agent-socket`와 `--controller-token-file`은 쌍으로 지정한다. 보호된 key를 읽고
broker 자신의 scope 등록을 승인받기 전에는 endpoint와 readiness를 게시하지 않는다.
각 요청은 broker의 scope를 새로 등록하고 실제 kernel peer PID·birth를 등록한 뒤에만
TCP syscall을 수행한다. 데몬 교체와 관측 전 orphan에도 환경값이나 과거 ancestry를
사용하지 않는다. 한 slot의 controller 요청/응답 buffer는 각각 2048 bytes이고,
두 등록은 순차적으로 같은 단일 FD와 최초 8초 기한을 공유한다. 부분 JSON·잘못된 tuple·
거절·취소에는 TCP를 실행하지 않는다. 승인 대기가 다른 client나 shutdown을 막지 않는다.

160-byte 요청 하나만 받으며 대기 중 추가 데이터나 write EOF(`SHUT_WR` 포함)는 취소다.
새 socket/accept FD를 전달하면 수신자가 전체 응답을 확인해 보내는 한 byte ACK까지
보내는 쪽 사본을 유지한다. ACK가 없거나 peer가 사라져도 최초 기한 안에서 회수한다.

Ancillary buffer는 [XNU의 최대 rights 수 512](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c)를 수용한다.
Darwin은 전체 FD를 설치한 뒤 작은 control buffer를 잘라 복사하므로, 작은 buffer와
`MSG_CTRUNC` 검사만으로는 빠진 FD를 닫을 수 없다. 한 data byte씩 받아 여러 rights
메시지를 합치지 않고, 한 loop의 수신 횟수를 제한한다. 잘못 전달된 FD는 그 수신 안에서
모두 닫으며 slot에 하나만 보관한다. 이때 최대 512개가 잠시 설치될 수 있으므로 retained
slot FD 한도와 transient kernel 전달 한도를 따로 계산해야 한다.

부모 디렉터리는 descriptor로 열어 symlink와 외부 소유자·공개 권한을 거부한다.
기존 endpoint를 시작 시 지우지 않으며 종료 시 자신이 만든 socket inode만 삭제한다.
macOS broker는 시작 시 0/1/2 이외의 상속 FD를 닫는다. workload launcher의 FD 정리는
독립적인 요구 사항이며 이 helper의 정리만으로 충족되지 않는다.
진단은 공유 `pm_dev_log`를 사용하고 frame/key 값을 기록하지 않는다.

## 외부 의존성

POSIX Unix/TCP sockets, SCM_RIGHTS, poll, fcntl, getifaddrs, macOS libproc.
공유 `pm_agent_scope_client.h`, `pm_dev_log.c`, agent JSON codec `portmanager_agent_json.c`를 사용한다.

## 상태와 남은 연결

현재 별도 소스 후보이며 제품 terminal attach/packaging에 연결하지 않았다.
커널 정책이 전달받은 미연결 FD의 직접 connect까지 차단하는지는 실제 합성 테스트로
확인했다. 이 확인을 socket 권한이 무조건 안전하게 이동한다는 일반 보장으로 해석하지 않는다.

Native hook은 broker env가 있을 때 cooperative opt-out보다 먼저 TCP를 중개한다.
실제 macOS 커널 정책에서 C의 blocking/nonblocking client와 server, 설치된 Node의
client/기본 IPv6 server, 설치된 Python client가 통과했다. Node/Python 주입은 SIP helper
실행 후 target exec 직전에 설정해야 한다. 테스트는 보호된 `sandbox-exec` 뒤의
`/usr/bin/env`로 이 동작을 검증한다. 환경값의 network id를 바꾸어도 broker 범위는 고정이다.

중복/20개/253개 rights와 잘못된 FD, accept 취소/flags 복원, 64 client 포화,
부분 frame의 절대 기한, 미확인 FD 전달 중 shutdown을 실제 별도 프로세스로 검증한다.

trusted route/Compose/host-access 정책과 실제 셸 attach·terminal replacement 연결이 필요하다. 프로토콜은
TCP만 다루며 UDP/DNS와 다른 런타임의 호환성은 별도 검증한다. 커널 정책 없이 같은 UID의
호스트 프로그램을 막는 경계로 사용하지 않는다. 공유 소스 쓰기는 사용자 선택대로 유지한다.
