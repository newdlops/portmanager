# UI

## 역할

Port Manager의 VS Code 사용자 인터페이스를 담당한다.

## 책임

- 사이드바 Tree View 구성
- 관리 중인 프로세스 표시
- Tree item context value와 command 연결

## 주요 진입점

- `sidebar/port-manager-tree.ts`

## 외부 의존성

- VS Code Extension API
- `src/core`
- `src/shared`

## 주의사항

UI는 플랫폼 명령을 직접 실행하지 않고 등록된 command로 동작을 위임한다.
