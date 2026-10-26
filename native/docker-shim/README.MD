# Docker Shim

## 역할

Docker/Podman PATH 앞에 놓이는 native 실행 파일로 Compose clone routing을 적용한다.

## 책임

- `docker`/`podman`/`docker-compose`/`podman-compose` 실제 실행 파일을 shim 디렉터리 밖의 PATH에서 찾는다.
- attached logical network의 compose project map을 읽어 Compose project 이름을 clone project로 바꾼다.
- Docker/Podman container 대상 명령에서 원본 container id/name을 안정적인 attached clone container target으로 바꾼다.
- routing TSV가 비어 있어도 route table과 Docker Compose label을 이용해 원본 container hash를 clone container로 복구한다.
- `docker cp container:path` 형태의 container 경로 인자를 보존하며 container 부분만 바꾼다.

## 주요 진입점

- `portmanager_docker_shim.c`: PATH shim 실행, routing map lookup, argv/env rewrite, real runtime exec

## 외부 의존성

- POSIX process 환경 변수와 `execv`
- extension/daemon이 쓰는 `PORT_MANAGER_COMPOSE_ROUTING_FILE`
- daemon이 쓰는 `PORT_MANAGER_ROUTES_FILE`
- terminal hook이 설정하는 `PORT_MANAGER_RUNTIME_SHIM_DIR`

## 주의사항

이 helper는 interactive shell function을 대체하지 않는다. Shell 안에서는 기존 함수가 유지되고,
shell 없이 `child_process.spawn("docker", ...)` 또는 `docker-compose`처럼 PATH만 타는 호출에서 native helper가 동작한다.

컨테이너 이름 치환은 컨테이너를 가리키는 인자 자리에만 한다. `pm_container_command_grammars` 가 명령마다
그 자리(`exec`·`logs` 등은 첫 위치 인자, `rm`·`stop` 등은 모든 위치 인자, `cp` 는 `컨테이너:경로` 인자)와
값을 받는 옵션을 정한다. 그래서 `exec -u rabbitmq <id> rabbitmqctl …` 의 사용자 값과 컨테이너 안 명령,
`rename` 의 새 이름, `cp` 의 로컬 경로는 서비스 이름과 같아도 바꾸지 않는다. 같은 표를 shell wrapper
(`compose-project-routing.ts` 의 `__port_manager_container_option_takes_value`)도 쓰며, 테스트가 두 표를 비교한다.

라우팅 행의 id 칸에는 16진 컨테이너 id 대신 이름(예: `rabbitmq`)이나 빈 값이 들어갈 수 있다. 짧은 해시를 위한
접두 일치는 토큰과 행 id 가 모두 16진 id 일 때만 쓴다. 이름은 정확히 같을 때만 일치한다.

실제 runtime 은 PATH 에서 `.portmanager-shim-stamp` 가 있는 디렉터리(다른 확장 세대의 shim 포함)를 모두 건너뛰고 찾는다.
