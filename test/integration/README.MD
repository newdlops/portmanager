# Packaged extension integration tests

## 역할

네이티브 CPU가 일치하는 일회용 CI VM에서 실제 VSIX의 설치와 활성화를 검증한다.

## 책임

- 빈 VS Code 프로필에 설치한 패키지의 파일과 버전을 확인한다.
- 확장 API, 명령 등록, 데몬 기동, DNS responder와 라우트 발행을 확인한다.
- 라우팅 세부 동작은 `test/unit`의 실제 네이티브 바이너리 테스트가 담당한다.

## 주요 진입점

`npm run test:packaged` → `scripts/test-packaged-extension.mjs` → `packaged-extension.ts`.

## 외부 의존성

공식 `@vscode/test-electron`, VS Code 다운로드, Linux의 Xvfb, 빌드된 대상별 VSIX.

## 주의사항

확장 활성화는 사용자 단위 셸 자산과 DNS 포트를 사용하므로 일회용 CI에서만 실행한다.
프로필과 임시 소켓은 매번 새로 생성한다. 화면 레이아웃, 관리자 DNS/TLS 설정,
Compose/worktree 온보딩의 수동 검증을 대체하지 않는다.
