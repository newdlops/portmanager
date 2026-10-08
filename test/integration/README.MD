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
  이벤트 루프 p99와 heap 사용량·용량, external/ArrayBuffer bytes를 JSON으로 기록한다.
- heap 영역·코드 용량·GC·context/handle 수를 JSONL에 증분 기록하고 최신 표본의 작은
  checkpoint만 원자적으로 갱신한다. 전체 JSON은 판정 뒤 한 번 저장한다. 누적 표본을
  매번 직렬화해 측정기 자체의 RSS를 키우지 않는다. `running`은 검증 통과가 아니다.

## 주요 진입점

`npm run test:packaged` → `scripts/test-packaged-extension.mjs` → `packaged-extension.ts`.

`Release packages`의 `resource_soak_seconds=1200`으로 20분 검증을 켠다.
`validation_target`으로 한 환경만 재실행할 수 있다(기본값 `all`). fixture의
VS Code 다운로드는 120초, 확장 활성화와 서비스 준비는 각 30초,
각 제어/정리 작업은 10초, VS Code test runner는 부하 시간 +180초로 제한해
시작·종료 지연이나 멈춘 작업을 로그가 남는 실패로 만든다.
원인 조사 실행은 `resource_heap_sampling=true`로 64KiB 간격의 할당 함수 표본을
추가한다. 객체 값·heap snapshot은 저장하지 않는다. 최종 20분 gate에서는 이
옵션을 끄며 GC 강제 실행과 기존 FD/RSS 판정 기준 변경은 하지 않는다.
CI 단계 자체도 20분 이하 workload에서는 30분으로 제한한다. macOS의 일회용
GUI runner는 `caffeinate -dis`로 실행 중 화면/시스템 idle sleep을 막고, 종료하면
자동 해제한다. 이것은 검증 환경을 일정하게 유지하기 위한 조치이며, 이전 지연의
원인이 sleep이었다는 뜻은 아니다.
VM 전체의 절전 차단은 준비 단계에서 시작해 실패 로그 업로드까지 유지한다.
이 CI 소유 프로세스는 runner cleanup이 종료하며 80분 상한도 가진다. 로그 artifact
업로드는 5분으로 제한하고, 실패/정리 수치는 job stdout에도 요약한다. ArtifactService
실패 때도 원본을 회수하도록 전체 숫자 보고서를 gzip/base64의 8KiB 로그 프레임으로
보관한다(`PM_RESOURCE_REPORT_GZIP_BASE64_*`). 이 작업은 앱 측정이 끝난 뒤 부모
launcher에서 수행하며 측정 대상 확장 호스트의 RSS 판정에 포함되지 않는다.
ArtifactService와 job log blob이 함께 유실돼도 조회 가능한 check annotation에
숫자 보고서를 추가 보관한다. 메시지 4,096자·단계당 notice 10개 제한을 지키도록
측정 종료 뒤 네 개의 별도 단계가 각각 4,000자 data frame을 최대 8개씩 기록한다.
32 frame을 넘으면 자르지 않고 보관 불가를 표시한다. `running` 보고서는 그대로
유지하며, annotation 복구 역시 원본 전체 표본과 최종 판정을 확인해야 한다.
macOS ARM의 부하 실행은 `supervise-packaged-validation.mjs`가 하나의 설치된 VSIX
확장 호스트를 연속 실행하고 stdout/stderr를 일반 파일에 보관한다. 준비 로그를
부하 전에 업로드하고, 동일 host PID의 baseline·5/10/15분 checkpoint를 부하 중
별도 artifact로 보존한다. checkpoint는 원인 조사용이며 `running`을 통과로
바꾸지 않는다. 최종 gate는 원래 20분 실행과 판정 뒤의 전체 보고서 및 launcher
종료 코드를 확인한다. 감독자는 원래 앱 watchdog과 별도로 설치/종료 여유를
포함한 유한 기한을 가지며, timeout/정리 시 PID와 고유 profile marker로 확인한
이 CI 실행 소유의 process group만 종료한다. 같은 호스트를 재시작하거나 예열,
GC, RSS/FD 기준을 바꾸지 않는다.
GUI 앱에는 `caffeinate -dis -w <VS Code PID>`도 연결하고 정상 종료/실패/기한 초과
때 함께 정리한다. ARM 장시간 재측정은 macOS 26 runner에서 같은 workload와 판정
기준을 사용하며, JSON은 OS release/version을 기록한다. macOS 15의 단기 실제 확장
호스트 검증과 전체 기능 회귀 결과도 별도로 보관한다.
`macos_arm_runner`로 macOS 14/15/26의 표준 M1 이미지를 선택할 수 있다. 기본은
26이며, 실행·결과 회수 경로를 진단하기 위한 이미지 선택은 workload·판정 기준을
변경하지 않는다. 실제 선택한 OS는 보고서에 기록한다.
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

<!-- proxy-resource-validation-results:start -->
## 2026-10-08 확정된 검증 결과와 남은 항목

macOS arm64의 20분 실제 확장 호스트 검증은 아직 완료되지 않았다. 30초 실행과
837개 단위·네이티브 테스트는 통과했으나, 장시간 CI의 완료 로그를 확보하지
못했다. 아래 네 환경은 원본 JSON에서 20분 이상 실행과 종료 후 예산 반환을
확인한 확정 결과다.

macOS 26 ARM의 2분 진단은 75 cycle·3,000 왕복·151 SSE heartbeat를 수행했다.
FD 변화는 0이고 종료 후 예산은 모두 0이었지만, 호스트 RSS 증가 100.9 MiB로
96 MiB 기준에 실패했다. 이 결과는 20분 통과 증거가 아니며, 전체 메모리 추세의
추가 조사가 필요하다.

최신 20분 재측정(`b5f754d`, run `37686151446`)은 CI가 45분 실행 상한을 넘겼고
취소로 종료됐다. job log 조회는 `404 BlobNotFound`, artifact는 0개였으므로
전체 heap 용량·external/ArrayBuffer·RSS 추세를 회수하지 못했다. 정상적인
장시간 실행과 로그 회수가 가능한 일회용 macOS ARM 환경에서 추가 검증이 필요하다.
단계 실패나 로그 부재를 검증 통과로 간주하지 않으며 96 MiB 기준은 유지한다.

추가 원인 조사에서는 terminal picker 갱신마다 `preparePersistentNativeHookLibrary`가
변경 없는 hook 두 개를 통째로 읽어 일시적인 Buffer를 반복 할당하는 경로를 찾았다.
macOS ARM/Node 22의 별도 새 프로세스에서 같은 128,064-byte hook을 500회 준비하면
heap은 약 4.5 MiB로 유지됐지만 RSS는 57.6 MiB 증가했다. source/target의
inode·size·mtime·ctime을 검증하고 최대 8개 metadata만 보관하는 수정 뒤에는 같은
재현의 RSS 증가가 7.0 MiB였고, 변경 없는 준비에서는 binary read가 0회였다.
같은 크기·mtime을 유지한 source/target 변경과 symlink 교체도 복구 테스트를 통과했다.
이 결과는 메모리 증가의 한 기여 경로를 입증하며 전체 확장 호스트의 단독 원인이나
20분 통과를 입증하지는 않는다.

별도 실제 macOS 26 ARM 2분 할당 진단(`0c79262`, run `37719023098`)은 수정 전
제품 코드로 80 cycle·3,200 왕복을 수행했다. major GC 뒤 heap 용량과 RSS가 감소했고,
마지막 RSS 증가는 44.4 MiB, FD 변화는 -3, 종료 후 예산은 모두 0이었다.
할당 표본 수집이 켜진 진단 결과이므로 최종 gate를 대신하지 않는다. 수정된 제품
코드(`3f8811e`)의 20분 검증(run `37719704960`)은 표본 수집을 끈 상태로 별도 실행했다.

`3f8811e` 재측정은 Linux ARM/Windows가 통과했으나 macOS ARM·Intel/Linux x64는
RSS 기준에 실패했다. macOS ARM 작업 로그에서 실제 1200.8초·813 cycle·32,520 왕복,
RSS +108.9 MiB·FD +0·종료 예산 모두 0을 회수했다. 전체 파일은 ArtifactService의
CreateArtifact 요청 시간 초과로 업로드되지 않았다. 이 결과도 통과로 분류하지 않는다.

이 실행에 추가한 전체 checkpoint 반복 저장은 측정기 자체의 큰 할당을 유발했다.
같은 413개 표본으로 별도 새 Node 22 프로세스에서 재현한 결과, 전체 재저장은
403,924,768 bytes를 쓰며 RSS가 127.2 MiB 증가했고 JSONL 증분 기록은
1,198,561 bytes·1.8 MiB였다. 따라서 checkpoint는 최신 표본만 유지하고 전체 기록은
JSONL에 추가하도록 수정했다. 판정 뒤 전체 JSON을 한 번 저장하며 30초 예열·20분
부하·FD +8/RSS +96 MiB 기준과 강제 GC 금지는 그대로 유지한다.

증분 기록 재측정(`2637998`, run `37723912431`)은 Intel macOS·두 Linux·Windows
fallback의 20분 gate를 통과했다. macOS 26 ARM은 부하 단계와 ArtifactService 업로드가
실패했고 마지막 정리 단계가 실행 상한 뒤 취소로 종료됐다. job log 다운로드도
404여서 압축 프레임을 회수하지 못했으므로 macOS ARM의 원본 판정은 미확정이다.
동일 제품/측정 코드와 기준의 macOS 14 ARM 진단(run `37728104757`)도 실행 상한을
넘긴 뒤 취소로 종료됐다. artifact는 0개, 개별 job log는 404였고 전체 run log archive도
빈 ZIP이어서 이 실행의 메모리 판정은 회수하지 못했다.

수정 후 macOS 26 ARM의 2분 정상 측정(`5f86059`, run `37733406776`)은 실제 설치된
VSIX의 확장 호스트에서 120.7초·92 cycle·3,680 왕복·151 SSE heartbeat를 수행했다.
할당 표본 수집은 껐고 강제 GC·예열·기준 변경 없이 RSS +84.7 MiB, FD -3,
종료 예산 모두 0을 원본 JSON과 동일한 JSONL에서 확인했다. 첫/마지막 settled
표본의 heap 물리 공간은 48.7 → 125.4 MiB(+76.8), live heap은 42.1 → 60.2 MiB,
external은 6.8 → 7.1 MiB, native/detached context는 1/0으로 유지됐다.
이 표본에서는 V8 heap 물리 공간 증가가 RSS 증가의 대부분에 해당하며, 전체
장시간 추세와 20분 gate 통과는 여전히 추가 확인이 필요하다.

check annotation 회수 경로를 추가한 동일 제품 코드의 macOS 26 ARM 20분 실행
(`8aad71a`, run `37734716878`)도 원본 보고서를 확보하지 못했다. 네 개의 보관 단계는
완료로 보고됐지만 두 artifact 업로드는 실패했고, 마지막 job 정리는 45분 상한을
넘겼다. 일반 취소 뒤에도 종료되지 않아 강제 취소했으며 최종 상태는 cancelled다.
최종 check annotation은 실행 상한·runner 용량 안내 2개뿐이며 보고서 frame은 0개다.
artifact도 0개, job log는 404 BlobNotFound, 전체 run archive는 빈 22-byte ZIP이었다.
따라서 이 실행의 부하 결과·RSS/FD·최종 예산 반환은 미확정이며 통과로 분류하지 않는다.
보관 형식은 기존 네 환경의 20분 보고서와 새 ARM 2분 보고서에서 원본 복원 일치를
검증했고, 로컬 실제 pipe의 reader를 500ms 지연한 네 segment도 byte 단위 일치했다.
이 검사는 CI에서의 원본 회수를 대신하지 않는다. 장시간 실행과 결과 회수가 가능한
일회용 macOS ARM 환경이 필요하며 20분·FD +8/RSS +96 MiB 기준은 유지한다.

| 환경 | 생성/삭제 cycle | TCP/HTTP 왕복 | 호스트 FD/handle 변화 | 호스트 RSS 중앙값: 첫/마지막 5분 (MiB) | 호스트 평균 CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| darwin-x64 | 637 | 25,480 | -6 | 199.5 → 219.4 | 24.5% |
| linux-arm64 | 1,052 | 42,080 | +0 | 257.5 → 265.2 | 12.2% |
| linux-x64 | 1,026 | 41,040 | +0 | 237.1 → 242.6 | 12.7% |
| windows | 930 | 37,200 | -2 | 79.8 → 59.9 | 4.3% |

총 3,645 cycle과 145,800 TCP/HTTP 왕복을 검증했다. 각 cycle에서
3개 network의 노출/연결을 생성하고 제거하면서 유지 중인 SSE를 확인했다.
종료 후 listener/client/upstream/native helper/DNS/route/HTTP 활성·대기/idle/control
예산은 위 네 환경 모두 0이었다.

macOS/Linux는 설치된 VSIX의 실제 확장 호스트·daemon과 자식을 측정했다.
Windows는 production Node proxy manager의 standalone 실행이며, Windows
네이티브 격리/VSIX 활성화 검증을 포함하지 않는다.

RSS는 V8/allocator 보유와 지연 초기화 때문에 최초 수치로 즉시 돌아오지 않는다.
표의 5분 중앙값과 전체 JSON 표본으로 변화를 확인할 수 있다. CPU는 호스트
프로세스의 누적 CPU 시간으로 계산한 한 코어 기준 수치이며, fixture와 샘플링
비용도 포함한다. process tree 표본에는 VS Code 서비스와 일시적 관찰 명령이
포함될 수 있으므로 애플리케이션 자체의 단독 비용이나 RSS 상한을 뜻하지 않는다.

제품 코드의 호스트명 bind 주소 선택 보완은 별도 전체 회귀 검증으로 확인했다.
macOS 두 환경은 각각 837/837 통과, Linux 두 환경은 각각 820 통과·16 플랫폼
조건 skip, Windows의 선택한 Node fallback suite는 98 통과·18 플랫폼 조건 skip이다.

- [네 환경 장시간 측정](https://github.com/newdlops/portmanager/actions/runs/37642599092): macOS arm64 job은 취소됐으며 위 네 job의 성공 artifact만 사용했다.
- [macOS arm64 30초 실제 확장 호스트 검증](https://github.com/newdlops/portmanager/actions/runs/37665793532)
- [macOS 26 ARM 2분 RSS 실패 진단](https://github.com/newdlops/portmanager/actions/runs/37681529261)
- [macOS arm64/macOS 26 장시간 재측정 — 취소, 결과 미회수](https://github.com/newdlops/portmanager/actions/runs/37686151446)
- [최종 제품 코드의 다섯 환경 회귀 검증](https://github.com/newdlops/portmanager/actions/runs/37645246517)

원본은 위 실행의 `logs-*` artifact와 로컬 `.tmp/proxy-resource-validation/20m/*/resource-soak.json`에 있다.
장시간 측정 commit은 네 환경 `1c2c1c7`, 전 플랫폼 제품 회귀 검증은 `9ee2338`이다.
이후에는 검증 fixture/CI의 시간 제한과 선택 실행을 보완했다. 장시간 workload는
숫자 bind 주소를 사용하며 호스트명 주소 선택은 별도 DNS quota·취소·시간 제한·
IPv4/IPv6 선택 테스트로 검증했다.
<!-- proxy-resource-validation-results:end -->
