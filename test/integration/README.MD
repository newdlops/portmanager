# Packaged extension integration tests

## 역할

네이티브 CPU가 일치하는 일회용 CI VM에서 실제 VSIX의 설치와 활성화를 검증한다.

## 책임

- 빈 VS Code 프로필에 설치한 패키지의 파일과 버전을 확인한다.
- 확장 API, 명령 등록, 데몬 기동, DNS responder와 라우트 발행을 확인한다.
- 라우팅 세부 동작은 `test/unit`의 실제 네이티브 바이너리 테스트가 담당한다.
- 선택한 시간 동안 실제 확장 호스트에서 네트워크 생성/삭제, TCP FIN·취소,
  HTTP GET/POST와 유지 중인 SSE를 함께 반복하며 공통 예산 반환을 검증한다.
- 확장 호스트와 데몬 및 자식들의 RSS, CPU 누적 시간, FD(Windows: handle),
  이벤트 루프 p99와 heap을 JSON으로 기록한다.

## 주요 진입점

`npm run test:packaged` → `scripts/test-packaged-extension.mjs` → `packaged-extension.ts`.

`Release packages`의 `resource_soak_seconds=1200`으로 20분 검증을 켠다.
`validation_target`으로 한 환경만 재실행할 수 있다(기본값 `all`). fixture의
VS Code 다운로드는 120초, 확장 활성화와 서비스 준비는 각 30초,
각 제어/정리 작업은 10초, VS Code test runner는 부하 시간 +180초로 제한해
시작·종료 지연이나 멈춘 작업을 로그가 남는 실패로 만든다.
macOS/Linux는 설치된 VSIX의 실제 확장 호스트를 사용한다. Windows job은
`proxy-resource-soak.ts`의 standalone 진입점에서 Node 대체 경로만 확인한다.
Windows 네이티브 격리나 VSIX 활성화 지원을 뜻하지 않는다.

실제 확장 호스트는 VS Code 자체의 지연 초기화를 위해 먼저 30초 예열한다.
각 생성/삭제 cycle 뒤 모든 proxy 예산이 유지 중인 SSE의 기준값으로 돌아와야
한다. 마지막에는 SSE도 닫고 남은 예산까지 반환하는지 확인한다. 수치에는 실제
사용량뿐 아니라 native helper의 보수적인 용량 예약이 포함된다.

steady state의 proxy helper 수는 증가하면 안 된다. 확장 호스트 FD/handle은
예열 뒤 +8 이하, RSS는 +96 MiB 이하를 실패 기준으로 사용하며 전체 표본을
보관해 추세를 검토한다. 이는 RSS 상한이나 임의 사용자 앱의 성능 보장이 아니다.
process tree에는 daemon과 일반 VS Code 자식/일시적 discovery 명령도 기록한다.

로컬 rehearsal은 `PM_TEST_RESOURCE_SOAK_SECONDS=30 node
out/test/integration/proxy-resource-soak.js`로 실행할 수 있다. 확장은 활성화하지
않으며 셸/DNS 자산을 쓰지 않는다. 보고서는 `.tmp/resource-soak.json`에 저장한다.

## 외부 의존성

공식 `@vscode/test-electron`, VS Code 다운로드, Linux의 Xvfb, 빌드된 대상별 VSIX.

## 주의사항

확장 활성화는 사용자 단위 셸 자산과 DNS 포트를 사용하므로 일회용 CI에서만 실행한다.
프로필과 임시 소켓은 매번 새로 생성한다. 화면 레이아웃, 관리자 DNS/TLS 설정,
Compose/worktree 온보딩의 수동 검증을 대체하지 않는다.
