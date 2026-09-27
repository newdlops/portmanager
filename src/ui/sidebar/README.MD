# Sidebar

## 역할

Port Manager Activity Bar의 Networks 뷰를 렌더링한다.

## 책임

- Logical Network를 루트에 바로 나열하고 각 네트워크의 상태를 텍스트로 요약
- 네트워크 아래에 라우팅 포트(논리 포트 → 실제 주소)와 연결(창 기본값, 터미널, Compose)을 평탄하게 표시
- 네트워크가 사라진 stale 라우트 스코프를 경고 행으로 표시
- Services, System(Health/DNS/Runtime/Activity/Maintenance) 섹션 표시
- 행 contextValue로 인라인 버튼·컨텍스트 메뉴를 연결 (네트워크 명령은 행이 아니라 메뉴)
- Activity Bar 배지로 실패 개수 표시

## 주요 진입점

- `port-manager-tree.ts`: `PortManagerTreeProvider`, 트리 아이템, 명령 인자 추출기
- `sidebar-presentation.ts`: 요약 문구(`formatSidebarSummary`/`formatSidebarCounts`)와 배지 집계(`summarizeSidebarIssues`)

## 외부 의존성

- VS Code TreeDataProvider / TreeView API
- `src/shared` 타입

## 주의사항

Tree item은 화면 표현만 담당하고, 프로세스 제어는 command 계층에 위임한다.
System 카테고리 그룹은 presentation-only이며 command, drag-and-drop, 도메인/플랫폼
동작을 소유하지 않는다. `sidebar-presentation.ts`는 순수 함수만 둔다.
`logicalNetwork` 등 contextValue는 package.json 메뉴 `when` 절이 `==`로 참조하므로
바꾸지 않는다. 레이아웃 원칙은 루트 `DESIGN.md`를 따른다.
