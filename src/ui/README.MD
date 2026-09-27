# UI

## 역할

Port Manager의 VS Code 사용자 인터페이스를 담당한다.

## 책임

- 사이드바 Tree View 구성
- Logical Network를 루트에 두고 그 아래 라우팅 포트와 연결을 바로 보여주는 기본 화면 표시
- NetworkSnapshot 기반 실제 상태 렌더링과 Activity Bar 실패 배지
- 네트워크 명령을 인라인 버튼과 그룹화된 context menu로 노출 (action row 없음)
- 레거시 관리형 프로세스 UI를 기본 화면에서 숨김
- Tree item context value와 command 연결

## 주요 진입점

- `sidebar/port-manager-tree.ts`

## 외부 의존성

- VS Code Extension API
- `src/core`
- `src/shared`

## 주의사항

UI는 플랫폼 명령을 직접 실행하지 않고 등록된 command로 동작을 위임한다.
레거시 daemon/routes/processes/listeners 렌더링 코드는 호환성을 위해 남아 있을 수 있지만, 기본 루트 트리에서는 노출하지 않는다.
