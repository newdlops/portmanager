# Docker Shim

## 역할

Docker/Podman PATH 앞에 놓이는 native 실행 파일로 Compose clone routing을 적용한다.

## 책임

- `docker`/`podman`/`docker-compose`/`podman-compose` 실제 실행 파일을 shim 디렉터리 밖의 PATH에서 찾는다.
- attached logical network의 compose project map을 읽어 Compose project 이름을 clone project로 바꾼다.
- Docker/Podman container 대상 명령에서 원본 container id/name을 attached clone container id로 바꾼다.
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
