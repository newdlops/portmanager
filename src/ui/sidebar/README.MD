# Sidebar

## 역할

Port Manager Activity Bar의 Processes 뷰를 렌더링한다.

## 책임

- 관리 중인 프로세스 목록 표시
- 요청 포트와 실제 포트 매핑 표시
- 프로세스별 컨텍스트 메뉴 연결

## 주요 진입점

- `port-manager-tree.ts`

## 외부 의존성

- VS Code TreeDataProvider API
- `src/core`

## 주의사항

Tree item은 화면 표현만 담당하고, 프로세스 제어는 command 계층에 위임한다.
