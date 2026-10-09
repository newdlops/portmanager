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
- FD 조회와 process table 사이에 종료한 자식은 OS의 ESRCH 또는 zombie 상태를 확인한
  경우에만 표본에서 제외한다. `kill(pid, 0)`은 zombie에도 성공하므로 그 결과만으로
  FD 조회 실패를 판정하지 않는다. 살아 있는 프로세스의 조회 오류와 권한 오류는
  검증 실패로 유지하며 RSS·FD·1200초 기준은 그대로 적용한다.
- process table을 읽기 위해 측정기가 직접 만든 `ps`는 spawn 결과의 실제 PID로만
  제외한다. 제품의 별도 `ps`와 같은 이름의 살아 있는 자식은 계속 조회하며, 그
  descriptor 실패는 검증 실패로 유지한다. PID 이름 기반의 일괄 제외는 하지 않는다.
- `lsof`의 stderr·stdout이 비어 있는 exit 1만 50ms 뒤 한 번 재조회한다. 실제 FD
  개수를 얻거나 OS가 종료를 확인해야 처리하며, 반복 실패·권한 오류·timeout은
  실패로 유지한다. FD +8·RSS +96MiB·1200초 기준은 바꾸지 않는다.

## 주요 진입점

`npm run test:packaged` → `scripts/test-packaged-extension.mjs` → `packaged-extension.ts`.

`PM_TEST_RUNTIME_TRACE=1`은 설치된 runtime의 prepare/adopt/ready/close 호출을
최근 128개 전이로 제한해 별도 JSON에 남긴다. 반환값·오류·기한은 바꾸지 않으며,
진단이 끝나면 원래 메서드를 복원한다. 최종 자원 검증에서는 이 옵션을 끈다.

테스트의 가용 포트 확인은 실제 listener 주소에 맞춘다. wildcard host exposure는
`0.0.0.0`로 확인하며, 실제 bind 오류를 무시하거나 성공으로 바꾸지 않는다.

실행기가 borrowed-network terminal에서 시작됐어도 부모에 이미 주입된 hook이 새
GUI 환경을 다시 채우지 못하게 해당 검사 프로세스의 hook을 비활성화한다. GUI는
정리된 환경으로 시작하며, 설치된 제품과 guarded fixture가 자기 네이티브 코드를
별도로 사용한다. 사용자 daemon·셸 설정이나 HOME은 바꾸지 않는다.

실제 SDK 터미널에 보내는 입력은 fixture `.cjs`를 실행하는 짧은 명령이다.
같은 프로그램·byte witness·10초 판정을 사용하며, 셸의 line editing 준비 전에
긴 quoted 프로그램이 PTY의 canonical 입력 버퍼에 걸리는 일을 피한다. fixture
프로그램은 확인 뒤 삭제하고, 실패 시에도 테스트 종료에서 남은 파일을 정리한다.

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
artifact와 runner stdout의 annotation이 함께 유실되는 경우를 대비해 각 immutable
checkpoint와 최종 숫자 보고서를 별도 프로세스에서 공개 Checks API로 직접 보관한다
(`scripts/publish-resource-trace.mjs`). 요청마다 최대 50개 annotation에 전체 gzip/base64
보고서를 넣고 JSON 바이트의 SHA-256을 기록한다. 크기를 초과하면 자르지 않고 실패한다.
응답의 check id·commit·annotation 수를 확인하며 20초 요청 기한을 둔다. 이 check는
`neutral`이고 원래 보고서의 `running`/`failed` 상태를 그대로 보존하므로 gate 통과가 아니다.
`checks: write` 토큰은 보관 단계에만 주며 측정 대상 앱에는 전달하지 않는다.
API 경계는 [GitHub Checks 문서](https://docs.github.com/en/rest/checks/runs)를 따른다.
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
## 2026-10-09 로컬 macOS ARM 20분 실제 VSIX 검증

사용자가 승인한 이 컴퓨터(Apple M5 Pro, macOS 26.4/25E246)에서 결합 소스
`71ddab91d1b05f3f9f1cd38076a419f097443536`의 실제 VSIX 0.0.8260을 새 프로필에
설치했다. VS Code 1.140.0의 실제 확장 호스트(Node v24.21.0)와 패키지의 native
daemon·host proxy·TCP router를 사용했다. 30초 예열, 요청 1200초, FD +8/RSS +96 MiB
기준은 그대로이며 heap sampling과 강제 GC는 사용하지 않았다.

1201.6초 부하, 497 cycle, 19,880 왕복, 1226 SSE heartbeat를 완료했다. settled
표본은 100개, 전체 표본은 203개다. 최종 호스트 RSS 증가는 **49.75 MiB**, FD
증가는 **3**으로 gate와 launcher가 모두 통과했다. 종료 후 10종 예산은 모두 0이며
검증용 프로필의 프로세스와 daemon도 종료됐다. 원본 JSON과 JSONL의 전체 표본이
일치하고 설치된 제품 JS/native 파일 88개가 VSIX 바이트와 일치한다.

로컬 fixture 보완은 별도 checkout `/private/tmp/pmi_mj0_zezc`에 있다. 새 프로필,
workspace, TMPDIR/socket, fixture home 저장소와 native daemon의 ephemeral DNS
포트를 사용했고 사용자 HOME은 변경하지 않았다. 첫 시도는 174.7초에 fixture의
ephemeral 포트 64153 충돌로 중단됐다. 정확한 점유자는 확인되지 않았다. 이후 실제
bind 주소와 이 Mac의 자동 클라이언트 범위 밖에서 포트를 고르도록 보완했으며 실제
제품 bind 오류를 무시하거나 부하·시간·판정 기준을 줄이지 않았다.

기존 VS Code/daemon의 프로세스 정체성은 유지됐다. 기존 홈 파일의 inode·크기·mtime·
권한은 유지됐지만 셸 자산 5개의 ctime 변경과 동시간 Node DNS fixture 이름에
해당하는 인증 키 2개 추가가 관찰됐다. ctime 발생 주체와 실행 전 내용 hash는 확보하지
않았으므로 전체 홈이 불변이었다고 주장하지 않는다. 이 관찰은 감사 원본에 보존했고
다른 fixture의 키나 셸 파일을 되돌리거나 삭제하지 않았다.

원본과 감사는 `.tmp/proxy-resource-validation/local-arm64-20261009/`에 있다.
첫 실패는 그 아래 `attempt-1-port-collision/`에 보존했다. 로컬 실행 소스 patch와
협업 handoff는 `/private/tmp/portmanager-security-coordination-20261008/`의
`local-packaged-validation.patch`와 `local-packaged-validation-handoff.json`이다.
main의 실행 소스/native 자산과 peer worktree를 덮어쓰지 않았다. broker/kernel WIP는
이 실행에 포함하지 않았다. 이 결과는 이 Mac의 resource gate이며 GitHub M1 runner의
로그 유실 원인이나 production kernel/attach 격리 완료를 증명하지 않는다.

## 2026-10-08 확정된 검증 결과와 남은 항목

당시 GitHub M1 runner의 20분 실제 확장 호스트 원본 검증은 완료되지 않았다. 30초 실행과
839개 단위·네이티브 테스트는 통과했으나, 장시간 CI의 완료 로그를 확보하지
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

연속 실행의 중간 checkpoint를 추가한 macOS 26 ARM 검증(`865b51b`, run `37752875410`)은
준비 로그와 실제 설치 VSIX의 baseline을 회수했다. 839개 단위·네이티브 테스트는
통과했고 baseline은 host PID 17775, `real-extension-host-and-daemon`, `running`이었다.
5/10/15분 snapshot 단계는 성공했으나 각 artifact 업로드와 최종 gate 단계는 실패했다.
45분 상한으로 job이 취소된 뒤에도 회수된 artifact는 준비 로그와 baseline뿐이었다.
job log는 404, 전체 run archive는 빈 22-byte ZIP, check annotation은 상한·용량 안내
2개뿐이었다. 따라서 최종 RSS/FD·실패 사유·정리 결과는 원본 보고서 없이는 판단할 수 없다.

공개 Checks API로 직접 보관한 재검증(`3734d25`, run `37766697079`)에서는 실제 VSIX
baseline을 회수해 원본 SHA-256 일치를 확인했다. host PID 19599, 30초 예열,
1200초 요청, heapSampling=false, `real-extension-host-and-daemon`, `running`이다.
5/10/15분 snapshot 단계는 성공했지만 직접 API와 artifact 보관은 모두 실패했고
최종 gate 단계는 감독 기한과 기존 45분 job 상한 뒤에도 진행 중으로 표시됐다.
11:42:30 UTC 정상 취소 요청 뒤 job은 11:50:50 UTC cancelled로 종료됐다.
강제 취소 요청 때는 이미 종료돼 적용되지 않았다. 종료 후 재조회에서도 artifact는
준비 로그와 baseline뿐이고, 직접 API check 역시 baseline만 남았다. job log는 404,
전체 archive는 빈 22-byte ZIP이었다. 이 실행의 최종 RSS/FD·반환 예산·gate 결과는
미확정이며, 원인 근거 없이 동등한 장기 실행을 다시 시작하지 않는다.

| 환경 | 생성/삭제 cycle | TCP/HTTP 왕복 | 호스트 FD/handle 변화 | 호스트 RSS 중앙값: 첫/마지막 5분 (MiB) | 호스트 평균 CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| darwin-x64 | 671 | 26,840 | +0 | 205.1 → 226.6 | 23.0% |
| linux-arm64 | 1,035 | 41,400 | +0 | 246.6 → 244.6 | 13.2% |
| linux-x64 | 1,034 | 41,360 | +0 | 263.1 → 261.8 | 11.6% |
| windows | 862 | 34,480 | -2 | 79.3 → 61.0 | 7.1% |

표는 증분 기록 재측정(`2637998`, run `37723912431`)의 원본 보고서 기준이다.
RSS 중앙값은 settled 표본의 첫/마지막 5분 구간에서 계산했다.
총 3,602 cycle과 144,080 TCP/HTTP 왕복을 검증했다. 각 cycle에서
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


<!-- native-transfer-benchmark:start -->
## Native TCP 전송 측정 (2026-10-09)

`scripts/benchmark-native-transfer.py`와 `native-transfer-bench.c`는 직접 TCP,
변경 전/후 production host exposure helper를 같은 숫자 loopback echo backend에
연결한다. 1개/8개 연결을 각 3초씩 5회 측정하며, 매 회 경로 순서를 바꾼다.
반환된 모든 바이트의 패턴과 sent/received 길이를 검사하고 FIN 뒤 응답을 끝까지
읽는다. 속도는 반환 payload의 MiB/s이며, echo는 같은 바이트를 양방향으로 보낸다.
64-byte 왕복은 100회 예열 뒤 1,000회 측정한다. 아래 지연값은 5회 각각의
percentile을 구한 뒤 중앙값을 낸 결과다.

환경: Apple M5 Pro, macOS 26.4 (25E246), darwin-arm64. 두 helper 모두
`-Wall -Wextra -Werror -O2 -arch arm64 -mmacosx-version-min=12.0 -pthread`로
빌드했다. 64KiB 방향별 버퍼, helper 연결 상한 32, DNS 상한 2, route는 동일하다.
새 전달부는 즉시 nonblocking send, 방향별 최대 4-chunk burst, Darwin kqueue,
FIN 이후 EAGAIN 버퍼 보존을 적용했다. 보안 kernel/broker/attach 후보는 포함하지 않는다.

| 범위 | 직접 TCP | 변경 전 proxy | 변경 후 proxy |
| --- | ---: | ---: | ---: |
| 1개 연결, payload 중앙값 (MiB/s) | 1,228.8 | 650.0 | 630.5 |
| 1개 연결, 최소–최대 (MiB/s) | 899.2–2,103.9 | 541.4–762.8 | 306.5–1,033.8 |
| 8개 연결, payload 중앙값 (MiB/s) | 1,243.6 | 비교 제외: 5회 중 4회 누락 | 768.5 |
| 8개 연결, 최소–최대 (MiB/s) | 1,068.7–1,435.6 | 비교 제외 | 658.2–863.4 |
| 64-byte 왕복 p50 (μs) | 59 | 148 | 124 |
| 64-byte 왕복 p95 (μs) | 108 | 261 | 199 |
| 64-byte 왕복 p99 (μs) | 143 | 350 | 266 |

이 실행은 p95 지연 약 24% 감소를 관찰했으며 단일 연결 처리량 증가를 입증하지
못했다. 표본 변동이 크므로 전체 가상 네트워크의 일률적인 속도 증가율로 해석하지
않는다. 변경 전 동시 연결은 FIN/EAGAIN 경로에서 데이터 누락이 발생했다.
새 구현은 단일/동시 연결 10개 표본 모두 길이·패턴 검사에 통과했고 소유한
backend/helper 프로세스는 모두 종료됐다. 새 16MiB 느린 수신자/FIN 검사와 기존
전송 수명·reset·admission·DNS·라우팅 검사를 포함한 macOS 대상 54개는 통과했다.
16MiB 검사 자체는 변경 전에도 통과했으며, 누락의 재현 근거는 bulk 측정과 별도
`pump-finish.log`의 HUP/EAGAIN 기록이다.

원본: `.tmp/proxy-throughput-20261009/final/result.json`, `samples.jsonl`,
`cleanup.json`, `build-inputs.json`; 회귀 로그와 적용 감사는 상위 디렉터리에 있다.
이전 installed VSIX 1200초 결과는 이전 소스의 증거이며 이번 kqueue 변경의
장시간 검증을 대신하지 않는다. 이번 Linux 재검증은 일회용 컨테이너의 패키지
저장소 TLS 인증서 오류로 빌드 시작 전에 종료됐으므로 통과로 집계하지 않았다.

재현 시 동일한 flags로 비교할 두 checkout의 host helper를 빌드해 각각
`<output>/host-before`, `<output>/host-after`로 둔다. 현재 fixture는 다음과 같이
빌드하고 실행한다. controller는 socket probe 전에 preload/scope를 제거하고
자신을 재실행한다. startup/bind 실패와 새 구현의 바이트 검사 실패는 실행을
실패 처리하며, baseline의 바이트 실패는 명시적으로 기록하고 속도 비교에서 제외한다.

```sh
bench_dir=/private/tmp/pm-tcp-transfer
mkdir -p "$bench_dir"
cc -Wall -Wextra -Werror -O2 -pthread test/integration/native-transfer-bench.c -o "$bench_dir/transfer-bench"
python3 scripts/benchmark-native-transfer.py --directory "$bench_dir" --seconds 3 --rounds 5
```

benchmark 결과는 standalone native helper의 측정이다. Borrowed Network 내부의
기존 직접 TCP 경로, 실제 extension host, UDP, DNS/브라우저 proxy 또는 미완성
kernel/broker 경계의 성능 측정을 뜻하지 않는다. 사용자의 실제 서비스와 VS Code는
이번 측정·반영 과정에서 재시작하지 않았다.
<!-- native-transfer-benchmark:end -->

## 로컬 설치본 터미널·자원 검증

`scripts/test-packaged-extension.mjs --isolated-local`은 이 Mac에 설치된 VS Code를
별도 user-data/extensions/workspace/temp 디렉터리에서 실행한다. HOME은 바꾸지
않고 테스트 시작 전에 `os.homedir()`만 private storage로 지정한다. 네이티브 agent
spawn의 기존 경계에서 독립 DNS 포트 0을 전달하며, 설치된 제품 파일은 변경하지 않는다.

macOS soak는 `packaged-terminal-lifecycle.ts`로 실제 SDK PTY의 취소·연결·전환·해제·
종료를 반복한다. 기존 lo0 alias 두 개를 이용하며 시스템 alias/resolver 설정을
변경하지 않는다. 실제 Node의 반환 바이트와 파일 기록으로 Host Access, public DNS,
타 네트워크 TCP/namespace 거부, env 위조·hook opt-out의 scope 변경 거부, 공유 소스
쓰기 및 fresh host shell의 detach를 검사한다. 출력에 명령이 보이는 것만으로 성공을
판정하지 않는다. kernel 내부의 descendant/orphan 정리는 네이티브 별도 증명이 필요하다.

첫 cycle은 window network default를 선택한 뒤 일반 New Terminal 명령으로
contributed profile을 실행한다. private READY의 실제 등록을 기다린 뒤 통신을
검사하고, window detach가 원래 workspace profile 값을 복원했는지도 확인한다.
로컬 fixture는 기존 exec adapter 경계에서 lo0/PF/Keychain 쓰기를 거부한다.
private HOME 경로만으로 전역 OS 설정이 분리된다고 가정하지 않는다. 이 제한에서
일반 조회·실제 native 실행은 그대로이며 privileged 설치 동작의 통과를 주장하지 않는다.

원래 1200초, 일반 GC, RSS 증가 96MiB 이하와 FD 증가 8 이하 기준을 유지한다.
마지막에는 `disposeAsync()`로 실제 native parent와 listener 종료까지 기다리고 모든
공유 budget 차원의 0을 요구한다. fixture의 관리 client를 먼저 닫아 자동 재연결을
막고, private agent에 인증된 shutdown을 요청한 뒤 실제 종료를 확인한다.
