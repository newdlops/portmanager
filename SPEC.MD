# Port Manager Extension Specification

## 1. 개요

Port Manager는 VS Code 확장으로, 개발 중 실행되는 응용프로그램의 요청 포트를 논리 포트로 관리하고 실제 OS bind 포트는 별도의 사용 가능 포트로 라우팅하며, 라우팅된 프로세스를 사이드 패널 GUI에서 관리하는 도구이다.

예를 들어 백엔드가 논리 포트 `8000`, 프론트엔드가 논리 포트 `3000`을 사용하도록 만들어져 있어도, Port Manager는 실제 bind 포트를 `58000`, `53000` 같은 가상 범위 포트로 배정할 수 있다. 이때 `8000 -> 58000`, `3000 -> 53000` 라우팅 테이블을 만들고, 사용자는 사이드 패널에서 논리 요청 포트와 실제 포트의 매핑을 확인하고 프로세스를 제어할 수 있다.

## 2. 목표

- 중복 포트 사용으로 인한 개발 서버 실행 실패를 줄인다.
- 응용프로그램이 요청한 논리 포트와 실제 사용 포트의 매핑을 관리한다.
- VS Code 사이드 패널에서 라우팅된 프로세스를 확인, 종료, 재시작, 포트 복사, 브라우저 열기 등의 작업을 수행한다.
- 포트 충돌 처리 정책을 설정으로 제어할 수 있게 한다.

## 3. 비목표

- 모든 운영체제에서 임의의 외부 프로세스의 소켓 바인딩을 완전히 투명하게 가로채는 것은 MVP 범위에 포함하지 않는다.
- 시스템 전체 포트 포워딩, 방화벽 규칙 변경, 커널 수준 네트워크 후킹은 기본 기능에 포함하지 않는다.
- Docker, Kubernetes, WSL, 원격 SSH 환경의 포트 매핑 자동 변경은 별도 확장 범위로 둔다.

## 4. 핵심 개념

### 4.1 요청 포트

응용프로그램 또는 사용자가 원래 사용하려고 한 포트이다.

예: `3000`

### 4.2 실제 포트

Port Manager가 응용프로그램에 실제로 bind하도록 할당한 사용 가능한 포트이다.

예: `53000`

### 4.3 라우팅

이 스펙에서 라우팅은 다음 의미로 사용한다.

- MVP: 프로세스 실행 전에 사용 가능한 실제 포트를 찾아 환경 변수, CLI 인자, task/debug 설정 등을 통해 실제 포트로 실행되도록 조정한다. 기본 모드는 논리 요청 포트를 점유하지 않고 해시 기반 가상 포트 범위에서 실제 포트를 고르는 방식이다.
- 고급 모드: 플랫폼별 네이티브 어댑터를 사용해 프로세스가 요청 포트를 사용하는 것처럼 보이게 하거나, 프록시/포워딩 계층을 구성한다.

### 4.4 논리 라우팅 테이블

Port Manager agent가 관리하는 `논리 포트 -> 실제 포트` 관계이다.

예:

```txt
8000 -> 58000
3000 -> 53000
```

응용프로그램 간 통신에서 논리적으로 `8000 -> 3000` 관계가 필요하면, Port Manager가 제공하는 테이블을 기준으로 실제 통신 대상은 `58000 -> 53000` 관계로 해석된다. MVP는 이 테이블을 agent snapshot과 프로세스 환경 변수로 제공하며, 임의 코드의 네트워크 호출을 투명하게 바꾸는 것은 프록시 또는 런타임 주입 계층의 확장 범위로 둔다.

## 5. 사용자 시나리오

### 5.1 논리 포트 라우팅

1. 사용자가 VS Code에서 개발 서버를 실행한다.
2. 해당 서버는 `3000` 포트를 요청한다.
3. Port Manager가 `3000`을 논리 포트로 유지하고 해시 기반 가상 포트 범위에서 실제 포트를 선택한다.
4. 프로세스는 실제 포트 `53000` 같은 포트로 실행된다.
5. 사이드 패널과 agent snapshot에는 `3000 -> 53000` 매핑이 표시된다.
6. `3000` 자체는 Port Manager가 실행한 프로세스에 의해 점유되지 않는다.

### 5.2 GUI 관리

1. 사용자가 VS Code Activity Bar에서 Port Manager 뷰를 연다.
2. 사이드 패널은 `Daemon`, `Routing Table`, `Managed Processes`, `OS Listening Ports` 아코디언 섹션으로 나뉜다.
3. 사용자는 daemon PID, 상태, 전체 listener 수, route 수, route table 파일 경로를 확인한다.
4. 사용자는 라우팅 테이블에서 논리 포트와 실제 포트의 관계를 확인한다.
5. 관리형 프로세스 항목에서 프로세스 이름, PID, 요청 포트, 실제 포트, 상태, 시작 시간을 확인한다.
6. 목록 행 클릭은 항목 선택만 수행하며 브라우저를 열지 않는다.
7. 사용자는 다음 동작을 명시적으로 수행할 수 있다.
   - 브라우저에서 열기
   - 실제 포트 URL 복사
   - 프로세스 종료
   - 동일 설정으로 재시작
   - 매핑 제거

중지된 프로세스는 재시작 또는 제거 대상으로만 남기고, 이전 요청 포트와 실제 포트 매핑을 활성 라우팅처럼 표시하지 않는다.

### 5.3 수동 등록

1. 사용자가 이미 실행 중인 프로세스를 사이드 패널에서 등록한다.
2. Port Manager가 해당 PID와 포트를 조회한다.
3. 사용자는 해당 프로세스를 관리 목록에 추가할 수 있다.

수동 등록된 외부 프로세스는 포트 충돌 전에 라우팅할 수 없으므로, 상태 조회와 종료 같은 관리 기능을 우선 제공한다.

### 5.4 터미널 listen 실패 복구

1. 사용자가 VS Code 터미널에서 직접 개발 서버를 실행한다.
2. 서버가 이미 점유된 포트에 bind를 시도하고 `Address already in use`, `EADDRINUSE`, Daphne의 `Couldn't listen on 127.0.0.1:8004` 같은 오류를 출력한다.
3. Port Manager가 VS Code shell integration 출력 스트림에서 실패 포트와 호스트를 감지한다.
4. 확장은 사이드 패널 포트 snapshot을 갱신하고, 해당 포트 점유 프로세스 정보를 가능한 범위에서 표시한다.
5. 사용자가 `Rerun Routed`를 선택하면 같은 명령을 Port Manager agent 관리형 실행 경로로 다시 실행한다.
6. 재실행된 프로세스는 요청 포트와 실제 포트 매핑을 생성하고, 사이드 패널에 표시된다.

이 경로는 첫 번째 bind 실패를 사전에 막는 기능이 아니라 실패를 감지한 뒤 라우팅된 재실행으로 복구하는 기능이다.

## 6. 기능 요구사항

### 6.1 포트 점유 감지

- 확장은 지정된 포트가 이미 사용 중인지 확인할 수 있어야 한다.
- 포트 점유 프로세스의 PID, 프로세스명, 명령어를 가능한 범위에서 조회해야 한다.
- daemon은 OS 전체 listening TCP 포트를 주기적으로 감시하고 사이드 패널에 자동 반영해야 한다.
- 확장은 선호 포트 목록을 백그라운드에서 감시하고, 외부 프로세스가 점유한 포트를 사이드 패널에 표시해야 한다.
- 확장은 OS 사용자 단위의 단일 local agent와 통신하고, 여러 VS Code 창은 동일한 agent snapshot을 공유해야 한다.
- agent는 전체 listening TCP 포트를 감시하고, 관리형 프로세스의 논리 요청 포트와 실제 라우팅 포트 매핑을 함께 제공해야 한다.
- agent는 실행 중인 관리형 프로세스의 논리 라우팅 테이블을 snapshot과 프로세스 환경 변수로 제공해야 한다.
- 확장은 VS Code shell integration이 제공하는 터미널 출력에서 listen/bind 실패 메시지를 감지하고 라우팅 재실행을 제안해야 한다.
- 플랫폼별 조회 방식을 지원해야 한다.
  - macOS/Linux: `lsof`, `netstat`, `ss` 중 사용 가능한 명령
  - Windows: `netstat`, PowerShell, `Get-NetTCPConnection`

### 6.2 실제 포트 탐색

- 기본 정책은 해시 기반 라우팅이다.
  - 요청 포트와 route scope를 해시해 가상 포트 범위 안의 실제 포트를 고른다.
  - 실제 포트가 사용 중이면 같은 가상 범위 안에서 선형 탐색한다.
  - 요청 포트는 실제 bind 포트로 사용하지 않는다.
- 호환 정책인 `nearest`에서는 요청 포트가 사용 중이면 설정된 범위 안에서 가장 가까운 사용 가능 포트를 찾는다.
- `nearest`의 기본 탐색 정책은 증가 방향이다.
  - `3000` 사용 중이면 `3001`, `3002`, `3003` 순서로 탐색
- 설정으로 라우팅 모드, 탐색 범위, 방향, 가상 포트 범위를 변경할 수 있어야 한다.

기본값:

```json
{
  "portManager.scanRange": 20,
  "portManager.scanDirection": "up",
  "portManager.routingMode": "hashed",
  "portManager.virtualPortRangeStart": 53000,
  "portManager.virtualPortRangeEnd": 59999
}
```

### 6.3 프로세스 실행 라우팅

- 확장은 사용자가 지정한 실행 명령을 감싸서 실행할 수 있어야 한다.
- 같은 요청 포트를 가진 관리형 프로세스가 여러 개 존재하는 것은 허용한다.
- 단, 실행 중인 실제 포트는 충돌하지 않아야 하며 agent는 실제 포트 기준으로 사용 가능한 포트를 선택한다.
- hashed 모드에서는 충돌이 없어도 요청 포트가 아니라 해시 기반 실제 포트로 실행한다.
- nearest 모드에서는 충돌이 없으면 요청 포트 그대로 실행한다.
- 충돌이 있으면 실제 포트를 할당하고 다음 방식 중 하나로 프로세스에 전달한다.
  - 환경 변수: `PORT=3001`
  - CLI 인자: `--port 3001`
  - package script 템플릿 치환: `${port}`
  - VS Code task/debug configuration 통합
- 확장은 실행 프로세스에 다음 환경 변수를 제공해야 한다.
  - `PORT_MANAGER_LOGICAL_PORT`
  - `PORT_MANAGER_ACTUAL_PORT`
  - `PORT_MANAGER_ROUTES`
  - `PORT_MANAGER_ROUTES_FILE`
- 터미널 실패 복구로 재실행하는 경우, 실패한 명령 안에 요청 포트 숫자가 있으면 `${port}` 템플릿으로 치환하고, 없으면 CLI 인자 방식으로 실제 포트를 전달한다.

### 6.4 프로세스 레지스트리

확장은 관리 중인 프로세스를 내부 레지스트리에 저장해야 한다.

필수 필드:

```ts
type ManagedProcess = {
  id: string;
  pid: number;
  name: string;
  command: string;
  cwd: string;
  requestedPort: number;
  actualPort: number;
  status: "starting" | "running" | "stopped" | "error";
  startedAt: string;
  stoppedAt?: string;
  url?: string;
  errorMessage?: string;
};
```

### 6.5 사이드 패널

VS Code Activity Bar에 `Port Manager` 뷰를 제공한다.

뷰는 다음 아코디언 섹션을 제공한다.

Daemon:

- 상태
- PID
- 전체 listener 수
- active route 수
- route table 파일 경로
- 마지막 갱신 시각

Routing Table:

- 논리 포트
- 실제 포트
- host
- owning process

Managed Processes:

- 프로세스 이름
- 상태
- PID
- 요청 포트
- 실제 포트
- URL
- 실행 시간

OS Listening Ports:

- local address
- port
- PID
- process name
- command

프로세스별 액션:

- Open in Browser: 실행 중인 프로세스에만 제공
- Copy URL: 실행 중인 프로세스에만 제공
- Stop: 실행 중이거나 시작 중인 관리형 프로세스에만 제공
- Restart: 실행 중, 중지, 오류 상태의 관리형 프로세스에 제공
- Remove: 모든 관리형 또는 감지된 항목에 제공

상단 액션:

- Refresh
- Add Process
- Stop All
- Open Settings

### 6.6 알림

- 포트 충돌이 감지되면 사용자에게 정보 알림을 표시한다.
- 예: `Port 3000 is busy. Routed app to 3001.`
- 터미널 출력에서 listen 실패가 감지되면 `Rerun Routed`와 `Show Ports` 선택지를 제공한다.
- 프로세스 실행 실패, 포트 탐색 실패, 권한 부족은 오류 알림으로 표시한다.

### 6.7 설정

확장은 다음 설정을 제공한다.

```json
{
  "portManager.enabled": true,
  "portManager.defaultHost": "localhost",
  "portManager.scanRange": 20,
  "portManager.scanDirection": "up",
  "portManager.routingMode": "hashed",
  "portManager.virtualPortRangeStart": 53000,
  "portManager.virtualPortRangeEnd": 59999,
  "portManager.preferredPorts": [3000, 3001, 5173, 8000, 8080],
  "portManager.autoOpenBrowser": false,
  "portManager.showConflictNotification": true,
  "portManager.watchPreferredPorts": true,
  "portManager.watchIntervalMs": 3000,
  "portManager.notifyOnDetectedConflict": true,
  "portManager.monitorAllListeningPorts": true,
  "portManager.detectTerminalListenFailures": true,
  "portManager.processKillSignal": "SIGTERM"
}
```

## 7. 명령

VS Code Command Palette에 다음 명령을 등록한다.

- `Port Manager: Start Daemon`
- `Port Manager: Daemon Status`
- `Port Manager: Start Managed Process`
- `Port Manager: Add Existing Process`
- `Port Manager: Refresh`
- `Port Manager: Stop Process`
- `Port Manager: Restart Process`
- `Port Manager: Stop All Processes`
- `Port Manager: Copy Routed URL`
- `Port Manager: Open Routed URL`

## 8. 아키텍처

### 8.1 Extension Host

확장 로직의 중심이다.

책임:

- 명령 등록
- 설정 로드
- 사이드 패널 provider 등록
- 프로세스 실행/종료 조정
- 상태 변경 이벤트 발행

### 8.2 Port Scanner

책임:

- 포트 사용 여부 확인
- 점유 프로세스 조회
- 해시 기반 가상 포트와 nearest 인접 포트 탐색

### 8.3 Process Launcher

책임:

- 사용자의 실행 명령 파싱
- 요청 포트 확인
- 라우팅 정책에 따른 실제 포트 할당
- 환경 변수 또는 CLI 인자로 실제 포트와 route table 전달
- child process lifecycle 관리

### 8.4 Process Registry

책임:

- 관리 중인 프로세스 상태 저장
- 프로세스 상태 변경 이벤트 제공
- VS Code workspace state에 최근 매핑 저장

### 8.5 Sidebar View

책임:

- 현재 레지스트리 상태 렌더링
- daemon 상태, 라우팅 테이블, 관리형 프로세스, OS listener를 아코디언 섹션으로 렌더링
- 사용자 액션을 VS Code command로 전달
- 수동 새로고침과 자동 상태 반영

## 9. 데이터 흐름

### 9.1 프로세스 실행

1. 사용자가 `Start Managed Process` 명령을 실행한다.
2. 확장이 실행 명령, 작업 디렉터리, 요청 포트를 입력받는다.
3. Port Router가 라우팅 모드에 따라 실제 포트를 선택한다.
4. Process Launcher가 실제 포트와 route table 환경 변수를 주입해 프로세스를 실행한다.
5. Process Registry가 논리 포트와 실제 포트 매핑을 저장한다.
6. Agent가 전체 OS listening port snapshot과 active route table을 갱신한다.
7. Sidebar View가 Daemon, Routing Table, Managed Processes, OS Listening Ports 섹션을 갱신한다.
8. 사용자가 실행 중인 실제 URL로 접근한다.

### 9.2 프로세스 종료

1. 사용자가 사이드 패널에서 Stop을 누른다.
2. Extension Host가 대상 PID를 찾는다.
3. Process Launcher가 설정된 종료 신호를 보낸다.
4. 상태가 `stopped`로 변경된다.
5. Sidebar View가 목록을 갱신한다.

## 10. 구현 단계

### Phase 1: 기본 확장 골격

- VS Code extension scaffold 구성
- Activity Bar 및 Sidebar View 등록
- Command Palette 명령 등록
- 기본 설정 스키마 작성

### Phase 2: 포트 탐색

- 포트 사용 여부 확인 API 구현
- 해시 기반 가상 포트 탐색과 nearest 인접 포트 탐색 구현
- 플랫폼별 점유 프로세스 조회 구현
- 단위 테스트 추가

### Phase 3: 관리형 프로세스 실행

- 실행 명령 입력 UI 구현
- 환경 변수/CLI 인자 기반 포트 전달 구현
- `PORT_MANAGER_ROUTES` 기반 논리 라우팅 테이블 전달 구현
- child process lifecycle 추적
- Process Registry 구현

### Phase 4: GUI 관리

- Daemon, Routing Table, Managed Processes, OS Listening Ports 아코디언 표시
- Stop, Restart, Copy URL, Open Browser 구현
- 상태 자동 갱신
- 오류 상태 표시
- 터미널 listen 실패 감지와 라우팅 재실행 프롬프트 구현

### Phase 5: 고급 라우팅

- OS 전체 투명 라우팅을 위한 프록시/SDK/런타임 주입/네이티브 오버레이 계층 설계
- task/debug configuration 통합
- 프로젝트별 실행 프로필 저장
- 프록시 또는 네이티브 어댑터 가능성 검토
- Docker/WSL/Remote 환경 지원 여부 검토

## 11. 제약 및 주의사항

- VS Code 확장만으로 임의의 외부 프로세스가 호출하는 `bind(3000)`을 운영체제 수준에서 투명하게 바꾸는 것은 불가능하거나 플랫폼별 네이티브 구현이 필요하다.
- MVP는 확장이 실행을 관리하는 프로세스에 대해 포트를 사전에 조정하는 방식으로 구현한다.
- MVP의 논리 라우팅 테이블은 프로세스 환경 변수와 agent snapshot으로 제공한다. 임의 코드의 `http://localhost:3000` 호출을 자동으로 `http://localhost:53000`으로 바꾸려면 프록시, SDK, 또는 런타임 주입이 필요하다.
- daemon은 OS 전체 listening port를 감시하고 표시하지만, 이미 외부 터미널에서 성공적으로 bind한 임의 프로세스를 사후에 다른 포트로 이동시킬 수는 없다.
- 컨테이너의 가상 오버레이 네트워크 같은 투명 라우팅은 네이티브 드라이버, per-process 런타임 주입, 또는 모든 traffic이 통과하는 local proxy 계층이 필요하다.
- VS Code 터미널에서 직접 실행된 프로세스는 첫 bind 실패 이후 터미널 출력 기반으로 감지하고, 사용자 확인 후 관리형 재실행으로 복구한다.
- 이미 실행된 외부 프로세스는 포트를 변경할 수 없으므로 감지와 관리 기능만 제공한다.
- 일부 포트 조회 명령은 권한 제한으로 인해 PID 또는 프로세스명을 얻지 못할 수 있다.
- Windows, macOS, Linux의 프로세스 종료 방식과 포트 조회 방식은 다르게 구현해야 한다.

## 12. 성공 기준

- hashed 모드에서 `3000` 포트가 비어 있어도 관리형 프로세스는 가상 포트 범위의 실제 포트로 실행되고 `3000`은 논리 포트로 남는다.
- nearest 모드에서 `3000` 포트가 점유된 상태로 관리형 프로세스를 실행하면 자동으로 `3001` 또는 사용 가능한 인접 포트로 실행된다.
- 사이드 패널에 `요청 포트 -> 실제 포트` 매핑이 표시된다.
- agent snapshot과 실행 프로세스 환경 변수에 논리 라우팅 테이블이 제공된다.
- 사이드 패널이 Daemon, Routing Table, Managed Processes, OS Listening Ports 아코디언으로 구분된다.
- Daemon 섹션에서 PID, 상태, listener 수, route 수, route table 파일 경로를 확인할 수 있다.
- 외부 프로세스가 종료되면 OS Listening Ports 섹션에서 해당 listener가 자동으로 사라진다.
- 같은 요청 포트를 가진 여러 관리형 프로세스가 각각 다른 실제 포트로 실행될 수 있다.
- 사이드 패널 행 클릭은 브라우저를 열지 않고 선택만 수행한다.
- 사용자가 사이드 패널에서 프로세스를 종료하고 재시작할 수 있다.
- URL 복사와 브라우저 열기 동작은 실행 중인 프로세스의 실제 포트를 기준으로만 수행된다.
- 중지된 프로세스는 이전 URL을 활성 라우팅으로 제공하지 않는다.
- Daphne의 `Couldn't listen on 127.0.0.1:8004: Address already in use` 같은 터미널 listen 실패가 감지되고 라우팅 재실행을 제안한다.
- 포트 탐색 실패, 프로세스 실행 실패, 권한 부족 상황이 사용자에게 명확히 표시된다.

## 13. 테스트 계획

- Port Scanner 단위 테스트
  - 사용 중인 포트 감지
  - 사용 가능한 포트 감지
  - 인접 포트 탐색
  - 탐색 범위 초과 처리

- Process Launcher 단위 테스트
  - 충돌 없는 실행
  - 충돌 시 실제 포트 주입
  - 프로세스 종료 상태 반영
  - 재시작 시 동일 요청 포트 기준 재탐색

- Sidebar View 테스트
  - 프로세스 목록 렌더링
  - 상태 변경 반영
  - 액션 버튼 명령 호출

- Terminal Conflict Parser 단위 테스트
  - Daphne listen 실패 메시지에서 host와 port 감지
  - 일반 `EADDRINUSE` 메시지에서 port 감지
  - 실패한 명령의 port를 `${port}` 템플릿으로 치환
  - port가 명령에 없을 때 CLI 인자 주입 모드 선택

- 통합 테스트
  - 테스트 서버가 `3000`을 점유한 상태에서 새 서버를 실행하면 `3001`로 라우팅되는지 확인
  - 여러 프로세스가 같은 요청 포트를 사용할 때 순차적으로 `3001`, `3002` 등으로 할당되는지 확인

## 14. 향후 확장

- 프로젝트별 포트 프로필 저장
- 프레임워크별 자동 포트 감지
  - Vite
  - Next.js
  - React Scripts
  - Express
  - Spring Boot
- VS Code task/debug configuration 자동 패치 제안
- 원격 개발 환경 지원
- 충돌 포트를 점유한 프로세스 종료 제안
- 포트 사용 히스토리와 최근 URL 목록 제공
