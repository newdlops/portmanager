# Media

## 역할

VS Code extension contribution에 필요한 정적 리소스를 보관한다.
패키징 시 native helper와 daemon 바이너리도 이 폴더 아래에 포함된다.

## 책임

- Activity Bar 아이콘 제공
- native hook, TCP router, daemon 실행 파일 보관

## 주요 진입점

- `port-manager.svg`
- `native/portmanager_agent`
- `native/portmanager_tcp_router`
- `native/libportmanager_hook.*`

## 외부 의존성

- `scripts/build-native-hook.sh`
- platform C compiler and codesign tools

## 주의사항

`native/` 아래 파일은 소스 자산이 아니라 패키징에 포함되는 빌드 산출물이다.
소스는 `native/` 루트의 각 모듈에 있으며 prepublish 단계에서 다시 빌드된다.
