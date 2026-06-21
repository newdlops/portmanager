# Config

## 역할

VS Code 사용자 설정을 Port Manager 도메인 설정으로 변환한다.

## 책임

- 기본 설정 제공
- VS Code workspace configuration 읽기
- 설정값 검증과 보정

## 주요 진입점

- `vscode-settings.ts`

## 외부 의존성

- VS Code Extension API
- `src/shared`

## 주의사항

설정 읽기 실패나 잘못된 값은 합리적인 기본값으로 보정한다.
